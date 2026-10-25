import {execFileSync} from 'node:child_process';
import {mkdir,cp,rm} from 'node:fs/promises';
await rm('hosted-dist',{recursive:true,force:true});
await mkdir('hosted-dist',{recursive:true});
await cp('hosted','hosted-dist',{recursive:true});
await cp('netlify/lib/workflows.mjs','hosted-dist/workflows.mjs');
await cp('src/agentos/static/assets','hosted-dist/assets',{recursive:true});
await cp('src/agentos/static/output.js','hosted-dist/output.js');
console.log('Built hosted frontend. No environment variables or local secrets included.');

execFileSync('python3',['-c',`from pathlib import Path
import zipfile
root=Path('src/agentos/static/linkedin-extension')
with zipfile.ZipFile('hosted-dist/browser-extension.zip','w',zipfile.ZIP_DEFLATED) as bundle:
 for name in ('manifest.json','background.js','popup.html','popup.js','companion.js','sidepanel.html','sidepanel.css','sidepanel.js','output.js','hosted-content.js','hosted-background.js'):
  bundle.write(root/name,'agentos-browser-companion/'+name)
`]);
