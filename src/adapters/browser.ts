import { createHmac } from "node:crypto";
import type { BrowserPort } from "../application/ports";
import type { BrowserEvidence } from "../domain/model";
import { Integrations } from "../server/integrations";
export class SpriteBrowser implements BrowserPort {
  constructor(
    private integrations: Integrations,
    private origin: string,
    private secret: string,
  ) {}
  async inspect(runId: string): Promise<BrowserEvidence> {
    if (!/^https:\/\//.test(this.origin))
      throw Error(
        "Browser inspection requires the configured HTTPS workspace origin.",
      );
    const expires = String(Date.now() + 10 * 60000),
      signature = createHmac("sha256", this.secret)
        .update("inspection:" + expires)
        .digest("hex");
    const payload = Buffer.from(
      JSON.stringify({
        id: runId,
        url: this.origin,
        cookie: `${expires}.${signature}`,
      }),
    ).toString("base64");
    const script = `const p=JSON.parse(Buffer.from(process.argv[1],'base64').toString());const fs=await import('node:fs/promises');const root='/home/sprite/company-os/browser';await fs.mkdir(root,{recursive:true});try{console.log(await fs.readFile(root+'/'+p.id+'.json','utf8'));process.exit(0)}catch{};const errors=[];await using view=new Bun.WebView({backend:{type:'chrome',url:false,argv:['--no-sandbox']},console:(level,...args)=>{if(level==='error')errors.push(args.map(String).join(' ').slice(0,800));}});await view.navigate('about:blank');await view.cdp('Network.setCookie',{name:'company_inspection',value:p.cookie,url:p.url,httpOnly:true,secure:true,sameSite:'Strict'});await view.cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await view.navigate(p.url);const steps=[];async function wait(){for(let i=0;i<100;i++){if(await view.evaluate("!!document.querySelector('[data-workspace-ready]')"))return;await Bun.sleep(100)}throw Error('Workspace did not load');}await wait();async function capture(action){await Bun.sleep(250);const data=await view.evaluate("({title:document.querySelector('h1')?.textContent||document.title,text:document.body.innerText.slice(0,16000),navigation:[...document.querySelectorAll('nav button')].map(b=>({visibleText:b.textContent,accessibleName:b.getAttribute('aria-label')})),overflow:document.documentElement.scrollWidth>innerWidth+1,url:location.href})");const screenshot=p.id+'-'+steps.length+'.png';await Bun.write(root+'/'+screenshot,await view.screenshot());steps.push({action,...data,screenshot});}await capture('Open workspace at desktop width');for(const label of ['Inbox','Documents','Knowledge','Automation']){const selector='nav button[aria-label="Open '+label+'"]';await view.scrollTo(selector);await view.click(selector,{timeout:8000});await capture('Click '+label);}await view.cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await view.reload();await wait();await capture('Reload at phone width');for(const label of ['Inbox','Documents','Knowledge','Automation']){const selector='nav button[aria-label=\"Open '+label+'\"]';await view.scrollTo(selector);await view.click(selector,{timeout:8000});await capture('Phone: click '+label);}const result={at:new Date().toISOString(),url:p.url,viewport:{width:390,height:844},steps,errors};await fs.writeFile(root+'/'+p.id+'.json',JSON.stringify(result));console.log(JSON.stringify(result));`;
    const result = await this.integrations.sprite.execFile(
      "bun",
      ["-e", script, payload],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    if (result.exitCode !== 0)
      throw Error(
        String(result.stderr).slice(-1500) || "Browser inspection failed",
      );
    return JSON.parse(String(result.stdout));
  }
  async artifact(path: string) {
    if (!/^[\w-]+-\d+\.png$/.test(path)) throw Error("Invalid artifact");
    const r = await this.integrations.sprite.execFile(
      "bun",
      [
        "-e",
        "console.log(Buffer.from(await Bun.file('/home/sprite/company-os/browser/'+process.argv[1]).arrayBuffer()).toString('base64'))",
        path,
      ],
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
    );
    if (r.exitCode !== 0) throw Error("Artifact unavailable");
    return new Uint8Array(Buffer.from(String(r.stdout).trim(), "base64"));
  }
}
