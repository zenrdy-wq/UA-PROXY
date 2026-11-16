'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {chromium}=require('playwright');
const cfgPath=process.env.UA_PROXY_CONFIG||path.join(__dirname,'..','config.json');
const cfg=JSON.parse(fs.readFileSync(cfgPath));
const providers=Object.keys(cfg.upstreams);const providerCount=providers.length;const sampleProvider=providers[0];
(async()=>{
 const browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--disable-gpu']});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:1080}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8788/');await page.waitForFunction(()=>document.querySelector('#stat-providers').textContent===String(providerCount));
 await page.screenshot({path:__dirname+'/overview-desktop.png',fullPage:true});
 await page.getByRole('link',{name:'Channels',exact:false}).first().click();await page.waitForSelector('.provider-card');assert.equal(await page.locator('.provider-card').count(),providerCount);
 await page.locator('#provider-search').fill(sampleProvider);assert.equal(await page.locator('.provider-card').count(),1);await page.getByRole('button',{name:'Edit channel',exact:true}).click();await page.waitForSelector('#provider-dialog[open]');assert.equal(await page.locator('input[name=apiKey]').inputValue(),'');assert.equal(await page.locator('input[name=name]').inputValue(),sampleProvider);await page.screenshot({path:__dirname+'/provider-dialog.png'});
 if(process.env.UA_QA_SAVE==='1'){
 const before=JSON.parse(fs.readFileSync(cfgPath));
 await page.getByRole('button',{name:'Save channel',exact:true}).click();await page.waitForSelector('#provider-dialog:not([open])',{state:'attached'});await page.waitForFunction(()=>document.querySelector('#service-status').textContent.includes('running'));
 const after=JSON.parse(fs.readFileSync(cfgPath));
 assert.equal(after.authToken,before.authToken);for(const name of Object.keys(before.upstreams))assert.equal(after.upstreams[name].apiKey,before.upstreams[name].apiKey);
 console.log('Live save/apply: provider edit, proxy restart, and preservation of all keys and proxy token passed.');
 }else await page.keyboard.press('Escape');
 await page.locator('#provider-search').fill('');await page.locator('#page-providers h1').click();await page.screenshot({path:__dirname+'/providers-desktop.png',fullPage:true});
 await page.keyboard.press('5');await page.waitForSelector('#page-settings:not([hidden])');assert.equal(await page.locator('#settings-form input[name=port]').inputValue(),'8787');assert.equal(await page.locator('#settings-form input[name=publicMode]').isChecked(),Boolean(cfg.publicMode));
 await page.keyboard.press('4');await page.waitForSelector('#page-models:not([hidden])');assert.equal(await page.locator('#model-provider option').count(),providerCount);
 await page.keyboard.press('3');await page.waitForSelector('#page-activity:not([hidden])');await page.keyboard.press('/');assert.equal(await page.locator('#activity-search').evaluate(e=>e===document.activeElement),true);
 await page.setViewportSize({width:390,height:844});await page.locator('#activity-search').blur();await page.goto('http://127.0.0.1:8788/#overview');await page.waitForFunction(()=>document.querySelector('#stat-providers').textContent===String(providerCount));
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.waitForTimeout(350);await page.screenshot({path:__dirname+'/overview-mobile.png',fullPage:true,animations:'disabled'});
 await page.locator('#mobile-menu').click();await page.locator('nav a[data-page=providers]').click();await page.waitForSelector('.provider-card');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);console.log('Browser QA: desktop/mobile layouts, navigation, search, key masking, dialogs, shortcuts, settings, no JS errors passed. No real upstream calls.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
