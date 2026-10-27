export function passageLocation(source){return source.pages?.length?'PDF '+(source.pages.length===1?'page ':'pages ')+source.pages.join(', '):'passage '+source.chunk;}
export function linkCitations(answer,sources,panel){
 const known=new Map(sources.map(source=>[source.citation,source])),walker=document.createTreeWalker(answer,NodeFilter.SHOW_TEXT),nodes=[];
 while(walker.nextNode()){const node=walker.currentNode;if(!node.parentElement.closest('a,code,pre,button,summary')&&/\[K\d+\]/.test(node.textContent))nodes.push(node);}
 for(const node of nodes){const text=node.textContent,fragment=document.createDocumentFragment();let offset=0;
  for(const match of text.matchAll(/\[(K\d+)\]/g)){const source=known.get(match[1]);if(!source)continue;fragment.append(document.createTextNode(text.slice(offset,match.index)));const button=document.createElement('button');button.type='button';button.className='citation-link';button.textContent=match[0];button.setAttribute('aria-label',`Read ${source.title}, ${passageLocation(source)}`);button.title=source.title+' · '+passageLocation(source);button.addEventListener('click',()=>{const details=[...panel.children].find(item=>item.dataset.citation===source.citation);if(!details)return;details.open=true;details.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});details.querySelector('summary').focus();});fragment.append(button);offset=match.index+match[0].length;}
  if(offset){fragment.append(document.createTextNode(text.slice(offset)));node.replaceWith(fragment);}
 }
}
