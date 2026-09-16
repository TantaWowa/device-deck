import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';

// This intentionally targets the existing Firebase project. No machine runtime
// directories, captures, browser credentials or local keys are uploaded.
const project = JSON.parse(await readFile('.firebaserc', 'utf8')).projects.default;
const hosting = JSON.parse(await readFile('firebase.json', 'utf8')).hosting;
const run = hosting.rewrites.find(rule => rule.run)?.run;
if (!project || !run) throw new Error('Firebase project and Cloud Run rewrite must be configured.');
const origin = process.env.PORTAL_ORIGIN || `https://${project}.firebaseapp.com`;
if (new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error('PORTAL_ORIGIN must be an HTTPS origin.');
const account = `device-deck-hub@${project}.iam.gserviceaccount.com`;
const secret = 'device-deck-portal-signing-key';
const image = `${run.region}-docker.pkg.dev/${project}/device-deck/hub:latest`;

function command(program, args, { capture = false, input, env } = {}) {
  const result = spawnSync(program, args, {
    encoding: 'utf8', stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'],
    input, env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.slice(0, 2).join(' ')} failed. Fix the reported error and rerun; existing resources are reused.`);
  return result.stdout?.trim();
}
const gcloud = (args, options) => command('gcloud', [...args, '--project', project, '--quiet'], options);
let accessToken;
let tokenTime = 0;
function token() {
  if (!accessToken || Date.now() - tokenTime > 240_000) {
    accessToken = command('gcloud', ['auth', 'print-access-token'], { capture: true });
    tokenTime = Date.now();
  }
  return accessToken;
}
async function api(url, { method = 'GET', body, allowMissing = false } = {}) {
  const response = await fetch(url, {
    method, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', 'X-Goog-User-Project': project },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404 && allowMissing) return undefined;
  const result = await response.json();
  if (!response.ok) throw new Error(`Google API ${response.status}: ${result.error?.message || response.statusText}`);
  return result;
}

console.log(`Verifying Device Deck before deploying ${origin}/app/ to ${project}.`);
command('npm', ['run', 'check']);
command('npm', ['run', 'test:portal']);
command('npm', ['run', 'build']);
command('npm', ['run', 'build:cloud']);
token(); // Fail before modifying cloud resources if the operator login expired.
const billing = JSON.parse(gcloud(['billing', 'projects', 'describe', project, '--format=json'], { capture: true }));
if (!billing.billingEnabled) throw new Error('Enable billing (Firebase Blaze) for this existing project, then rerun.');
gcloud(['services', 'enable', 'run.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com',
  'secretmanager.googleapis.com', 'firestore.googleapis.com', 'identitytoolkit.googleapis.com', 'firebase.googleapis.com', 'firebasehosting.googleapis.com']);

// Firebase Auth's Google OAuth client is configured in its console. Preserve
// existing settings and require both login methods before publishing the PWA.
const authUrl = `https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config`;
const auth = await api(authUrl, { allowMissing: true });
if (!auth) throw new Error(`Initialize Authentication and enable Google plus Email/Password at https://console.firebase.google.com/project/${project}/authentication/providers, then rerun.`);
const google = await api(`https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/defaultSupportedIdpConfigs/google.com`, { allowMissing: true });
if (!google?.enabled) throw new Error(`Enable Google sign-in at https://console.firebase.google.com/project/${project}/authentication/providers, then rerun.`);
const domains = [...new Set([...(auth.authorizedDomains || []), new URL(origin).hostname])];
await api(`${authUrl}?updateMask=authorizedDomains,signIn.email`, { method: 'PATCH', body: {
  authorizedDomains: domains, signIn: { email: { enabled: true, passwordRequired: true } },
} });

const firebaseBase = 'https://firebase.googleapis.com/v1beta1';
let apps = await api(`${firebaseBase}/projects/${project}/webApps`);
let app = apps.apps?.find(item => item.displayName === 'Device Deck Portal');
if (!app) {
  let operation = await api(`${firebaseBase}/projects/${project}/webApps`, { method: 'POST', body: { displayName: 'Device Deck Portal' } });
  for (let attempt = 0; !operation.done && attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    operation = await api(`${firebaseBase}/${operation.name}`);
  }
  if (operation.error || !operation.done) throw new Error('Firebase web app creation did not finish; rerun shortly.');
  app = operation.response;
}
const config = await api(`${firebaseBase}/${app.name}/config`);
const publicConfig = { apiKey: config.apiKey, appId: config.appId, authDomain: new URL(origin).hostname,
  projectId: project, messagingSenderId: config.messagingSenderId, portalOrigin: origin };
await writeFile('dist/app/firebase-config.json', JSON.stringify(publicConfig, null, 2) + '\n');

const databases = JSON.parse(gcloud(['firestore', 'databases', 'list', '--format=json'], { capture: true }));
if (!databases.some(database => database.name.endsWith('/(default)')))
  gcloud(['firestore', 'databases', 'create', '--database=(default)', `--location=${run.region}`, '--type=firestore-native']);
gcloud(['firestore', 'fields', 'ttls', 'update', 'deleteAfter', '--collection-group=pairings', '--enable-ttl', '--async']);
const accounts = JSON.parse(gcloud(['iam', 'service-accounts', 'list', '--format=json'], { capture: true }));
if (!accounts.some(item => item.email === account))
  gcloud(['iam', 'service-accounts', 'create', 'device-deck-hub', '--display-name=Device Deck machine registry']);
for (const role of ['roles/datastore.user', 'roles/firebaseauth.viewer'])
  gcloud(['projects', 'add-iam-policy-binding', project, `--member=serviceAccount:${account}`, `--role=${role}`, '--condition=None']);
const secrets = JSON.parse(gcloud(['secrets', 'list', '--format=json'], { capture: true }));
if (!secrets.some(item => item.name.endsWith(`/${secret}`))) {
  const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  gcloud(['secrets', 'create', secret, '--replication-policy=automatic', '--data-file=-'], { input: JSON.stringify(key) });
}
gcloud(['secrets', 'add-iam-policy-binding', secret, `--member=serviceAccount:${account}`, '--role=roles/secretmanager.secretAccessor']);
const repositories = JSON.parse(gcloud(['artifacts', 'repositories', 'list', `--location=${run.region}`, '--format=json'], { capture: true }));
if (!repositories.some(item => item.name.endsWith('/device-deck')))
  gcloud(['artifacts', 'repositories', 'create', 'device-deck', '--repository-format=docker', `--location=${run.region}`]);
gcloud(['builds', 'submit', '.', '--config=apps/cloud/cloudbuild.yaml', `--substitutions=_IMAGE=${image}`]);
gcloud(['run', 'deploy', run.serviceId, `--image=${image}`, `--region=${run.region}`, `--service-account=${account}`,
  '--allow-unauthenticated', '--min-instances=0', '--max-instances=2', '--cpu=1', '--memory=512Mi',
  `--set-env-vars=NODE_ENV=production,FIREBASE_PROJECT_ID=${project},PORTAL_ORIGIN=${origin}`,
  `--set-secrets=PORTAL_SIGNING_KEY_JSON=${secret}:latest`]);
// Firebase CLI accepts a short-lived OAuth access token in this environment
// variable. It is never passed in argv, printed, or persisted by this script.
command('npx', ['--yes', 'firebase-tools@15.30.1', 'deploy', '--only', 'hosting,firestore:rules', '--project', project, '--non-interactive'],
  { env: { FIREBASE_TOKEN: token() } });
const key = await fetch(`${origin}/api/v1/public-key`, { signal: AbortSignal.timeout(30_000) });
if (!key.ok || (await key.json()).issuer !== origin) throw new Error('Deployment finished but public-key health verification failed.');
const unauthenticated = await fetch(`${origin}/api/v1/machines`, { signal: AbortSignal.timeout(30_000) });
if (unauthenticated.status !== 401) throw new Error('Deployment finished but the registry authentication check failed.');
console.log(`Portal deployed: ${origin}/app/\nPair hosts using: devdeck network enable --host 0.0.0.0 --portal ${origin}`);
