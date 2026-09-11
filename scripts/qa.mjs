import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const base = process.env.QA_URL || 'http://127.0.0.1:5175';
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {});
await mkdir('outputs', {recursive:true});
const errors=[];
const checks=[];
async function check(name,fn){await fn();checks.push(name);}
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);
 await check('marketing assets load',async()=>{await page.evaluate(()=>document.querySelectorAll('img').forEach(i=>i.loading='eager'));await page.waitForFunction(()=>[...document.images].every(i=>i.complete));assert.equal(await page.locator('img').evaluateAll(imgs=>imgs.some(i=>!i.naturalWidth)),false);});
 await check('all integration tabs change examples',async()=>{for(const name of ['MCP','API','JSON','CLI']){await page.getByRole('tab',{name,exact:true}).click();assert.equal(await page.getByRole('tab',{name,exact:true}).getAttribute('aria-selected'),'true');}});
 await check('all internal links resolve',async()=>{const hrefs=await page.locator('a[href]').evaluateAll(links=>[...new Set(links.map(a=>a.getAttribute('href')))]);for(const href of hrefs){if(href.startsWith('#')){if(href.length>1)assert.equal(await page.locator(href).count(),1);}else if(href.startsWith('/'))assert.equal((await page.request.get(new URL(href,base).href)).status(),200);}});
 await page.screenshot({path:'outputs/website-desktop.png',fullPage:true});
 await page.goto(base+'/demo/');
 await page.getByRole('heading',{name:'Devices',exact:true}).waitFor();
 await check('physical and virtual inventory filters',async()=>{await page.getByRole('button',{name:'Virtual 2',exact:true}).click();assert.equal(await page.locator('.device-card').count(),2);await page.getByRole('button',{name:'All devices 4',exact:true}).click();assert.equal(await page.locator('.device-card').count(),4);});
 await check('search filters devices',async()=>{await page.getByRole('textbox',{name:'Find a device'}).fill('Pixel');assert.equal(await page.locator('.device-card').count(),1);await page.getByRole('textbox',{name:'Find a device'}).fill('');});
 await check('remote input changes fictional screen',async()=>{await page.getByRole('button',{name:'Right',exact:true}).click();assert.equal(await page.locator('.tv-copy h3').innerText(),'The quiet coast');});
 await check('screenshot and recording produce labelled demo entries',async()=>{await page.getByRole('button',{name:'Screenshot',exact:true}).click();await page.getByRole('button',{name:'Record video',exact:true}).click();await page.getByRole('button',{name:'Stop recording',exact:true}).click();assert.equal(await page.locator('.artifact-list button').count(),2);});
 await check('other owner blocks capture',async()=>{await page.locator('.device-card').filter({hasText:'Living room TV'}).click();assert.equal(await page.getByRole('button',{name:'Screenshot',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'In use by an agent'}).isDisabled(),true);});
 await check('release, reserve and renew work',async()=>{await page.locator('.device-card').filter({hasText:'Desk Roku'}).click();await page.getByRole('button',{name:'Release',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Screenshot',exact:true}).isDisabled(),true);await page.getByRole('button',{name:'Reserve device'}).click();await page.getByLabel('What are you working on?').fill('Browser QA');await page.getByRole('button',{name:'Reserve for 15 minutes'}).click();await page.getByRole('button',{name:'Renew',exact:true}).click();assert.match(await page.locator('.lease-panel').innerText(),/Browser QA/);});
 await check('recording persists across demo views',async()=>{await page.getByRole('button',{name:'Record video',exact:true}).click();await page.getByRole('button',{name:'Capture sources',exact:true}).click();await page.getByRole('button',{name:'Devices 4',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Stop recording',exact:true}).count(),1);await page.getByRole('button',{name:'Release',exact:true}).click();});
 await check('source pairing blocks in-use changes and accepts released changes',async()=>{await page.getByRole('button',{name:'Capture sources',exact:true}).click();await page.getByRole('combobox',{name:'Device paired to HDMI capture B'}).selectOption('');assert.equal(await page.getByRole('combobox',{name:'Device paired to HDMI capture B'}).inputValue(),'android-tv');await page.getByRole('combobox',{name:'Device paired to HDMI capture A'}).selectOption('');assert.equal(await page.getByRole('combobox',{name:'Device paired to HDMI capture A'}).inputValue(),'');await page.getByRole('combobox',{name:'Device paired to HDMI capture A'}).selectOption('roku-desk');});
 await check('captures explicitly identify simulated files',async()=>{await page.getByRole('button',{name:'Captures',exact:true}).click();await page.locator('.capture-card').first().click();assert.match(await page.getByRole('dialog').innerText(),/No playable recording was created/);await page.getByRole('button',{name:'Close dialog'}).click();});
 await page.screenshot({path:'outputs/captures-preview.png',fullPage:true});
 await page.getByRole('button',{name:'Reset demo'}).click();
 await page.getByRole('status').waitFor({state:'hidden'});
 await page.screenshot({path:'outputs/dashboard-preview.png',fullPage:true});
 await page.locator('.session').screenshot({path:'outputs/session-preview.png'});
 for(const width of [390,768,1440]){
  await page.setViewportSize({width,height:1000});
  for(const route of ['/','/demo/']){await page.goto(base+route);await page.evaluate(()=>document.querySelectorAll('img').forEach(i=>i.loading='eager'));await page.waitForFunction(()=>[...document.images].every(i=>i.complete));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${route} overflows at ${width}`);if(width===390)await page.screenshot({path:`outputs/${route==='/'?'website':'dashboard'}-mobile.png`,fullPage:true});}
 }
 checks.push('website and dashboard fit 390, 768 and 1440px widths');
 await page.setViewportSize({width:390,height:1000});await page.goto(base);
 await check('mobile menu navigates',async()=>{await page.getByRole('button',{name:'Open menu'}).click();await page.getByRole('link',{name:'Development status',exact:true}).click();assert.match(page.url(),/#status$/);});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({base,checks,consoleErrors:errors},null,2));
} finally {await browser.close();}
