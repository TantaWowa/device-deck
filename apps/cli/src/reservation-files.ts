import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  DeckError,
  reservationGroupManifestSchema,
  type ReservationGroupManifest,
} from "../../../packages/core/src/local/types";
import { callOperation, selectedDeck } from "../../../packages/core/src/client";

function assertCredentialDeck(value: { deck?: unknown }) {
  if ((value.deck || "local") !== selectedDeck())
    throw new DeckError("arguments", `This credential belongs to Deck ${value.deck || "local"}. Select that Deck explicitly before using it.`, 400);
}

async function jsonFile(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new DeckError(
      "arguments",
      `Unable to read reservation JSON ${file}: ${(error as Error).message}`,
      400,
    );
  }
}

export async function readReservationManifest(
  file: string,
): Promise<ReservationGroupManifest> {
  const parsed = reservationGroupManifestSchema.safeParse(await jsonFile(file));
  if (!parsed.success)
    throw new DeckError(
      "arguments",
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
      400,
    );
  return parsed.data;
}

export async function readGroupCredential(file: string) {
  const value = await jsonFile(file);
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.groupId !== "string" ||
    !value.groupId ||
    typeof value.leaseToken !== "string" ||
    !value.leaseToken
  )
    throw new DeckError(
      "arguments",
      "Reservation result must contain groupId and leaseToken.",
      400,
    );
  assertCredentialDeck(value);
  return { groupId: value.groupId, leaseToken: value.leaseToken };
}

export async function prepareGroupCredential(
  file: string,
  groupId: string,
  createToken: () => string,
) {
  try {
    const current = await readFile(file, "utf8");
    const value = JSON.parse(current);
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.groupId !== "string" ||
      !value.groupId ||
      typeof value.leaseToken !== "string" ||
      !value.leaseToken
    )
      throw new DeckError(
        "arguments",
        "Reservation result must contain groupId and leaseToken.",
        400,
      );
    const credential = {
      groupId: value.groupId as string,
      leaseToken: value.leaseToken as string,
    };
    assertCredentialDeck(value);
    if (credential.groupId !== groupId)
      throw new DeckError(
        "arguments",
        `Refusing to overwrite ${file}: it belongs to reservation group ${credential.groupId}.`,
        400,
      );
    return credential;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const credential = { groupId, leaseToken: createToken() };
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const candidate = `${file}.${process.pid}.${randomUUID()}.credential`;
  const handle = await open(candidate, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ ...credential, ...(selectedDeck() !== "local" ? { deck: selectedDeck() } : {}) }, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // Publish a complete file only if the destination is still absent.
    // Concurrent callers read and reuse the winning credential.
    await link(candidate, file);
    return credential;
  } catch (publishError) {
    if ((publishError as NodeJS.ErrnoException).code !== "EEXIST")
      throw publishError;
    const winner = await readGroupCredential(file);
    if (winner.groupId !== groupId)
      throw new DeckError(
        "arguments",
        `Refusing to use ${file}: it belongs to reservation group ${winner.groupId}.`,
        400,
      );
    return winner;
  } finally {
    await unlink(candidate).catch(() => {});
  }
}

export async function releaseGroupCredential(
  credential: { groupId: string; leaseToken: string },
  call: typeof callOperation = callOperation,
) {
  try {
    return await call("sessions.releaseGroup", credential);
  } catch (error) {
    // The CLI persists its credential before dispatch. If admission failed
    // before commit there is no group to authenticate, which is already the
    // desired released state. Existing groups still validate their token.
    if ((error as DeckError).code === "group-not-found")
      return { groupId: credential.groupId, state: "not-found" as const };
    throw error;
  }
}

export function reservationCommandOutput(
  result: Record<string, unknown>,
  resultFile?: string,
) {
  if (!resultFile) return result;
  const { leaseToken: _secret, ...safe } = result;
  return { ...safe, credentialFile: resultFile };
}
