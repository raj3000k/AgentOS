import {mkdir,cp,rm} from 'node:fs/promises';
await rm('hosted-dist',{recursive:true,force:true});
await mkdir('hosted-dist',{recursive:true});
await cp('hosted','hosted-dist',{recursive:true});
await cp('src/agentos/static/assets','hosted-dist/assets',{recursive:true});
await cp('src/agentos/static/output.js','hosted-dist/output.js');
console.log('Built hosted frontend. No environment variables or local secrets included.');
