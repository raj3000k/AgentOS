// Progressive decoration only: native scrolling, no interaction or model state changes.
export function initMotion(){
 const reduced=matchMedia('(prefers-reduced-motion: reduce)'),fine=matchMedia('(hover: hover) and (pointer: fine)');
 const revealSelector='.platform-heading,.landing-category,.platform-steps article,.hero-copy,.hero-art,.workflow-card,.prompt-suggestions,.knowledge-layout>.brief-composer,.knowledge-library>.library-card';
 const tiltSelector='.landing-category,.workflow-card,.hero-art';
 const tracked=new WeakSet(),tilts=new Set();let frame=0,pointer=null;
 const progress=document.createElement('div');progress.className='reading-progress';progress.setAttribute('aria-hidden','true');document.body.append(progress);
 const reveal=node=>{node.classList.add('is-visible');observer?.unobserve(node);};
 const observer='IntersectionObserver' in window?new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting)reveal(entry.target);},{threshold:0.08,rootMargin:'0px 0px -20px 0px'}):null;
 function register(root){
  const nodes=[...(root.matches?.(revealSelector)?[root]:[]),...root.querySelectorAll(revealSelector)];
  for(const node of nodes){if(tracked.has(node))continue;tracked.add(node);node.classList.add('motion-reveal');if(reduced.matches||!observer)reveal(node);else observer.observe(node);}
  const cards=[...(root.matches?.(tiltSelector)?[root]:[]),...root.querySelectorAll(tiltSelector)];
  for(const card of cards){if(tilts.has(card))continue;tilts.add(card);card.classList.add('depth-card');card.addEventListener('pointermove',event=>{if(reduced.matches||!fine.matches||event.pointerType==='touch')return;pointer={card,x:event.clientX,y:event.clientY};schedule();});card.addEventListener('pointerleave',()=>{if(pointer?.card===card)pointer=null;reset(card);});}
 }
 function reset(card){for(const key of ['--tilt-x','--tilt-y','--light-x','--light-y'])card.style.removeProperty(key);card.classList.remove('is-tilting');}
 function paint(){
  frame=0;if(reduced.matches)return;
  const height=document.documentElement.scrollHeight-innerHeight;progress.style.setProperty('--read',String(height>0?Math.min(1,Math.max(0,scrollY/height)):0));
  for(const art of document.querySelectorAll('.hero-art,.login-art')){const rect=art.getBoundingClientRect();if(rect.height&&rect.bottom>0&&rect.top<innerHeight){const offset=Math.max(-16,Math.min(16,(innerHeight/2-rect.top-rect.height/2)*0.035));art.style.setProperty('--parallax',offset.toFixed(2)+'px');}}
  if(pointer?.card.isConnected){const {card,x,y}=pointer,rect=card.getBoundingClientRect(),px=Math.max(0,Math.min(1,(x-rect.left)/rect.width)),py=Math.max(0,Math.min(1,(y-rect.top)/rect.height));card.style.setProperty('--tilt-x',((.5-py)*4).toFixed(2)+'deg');card.style.setProperty('--tilt-y',((px-.5)*4).toFixed(2)+'deg');card.style.setProperty('--light-x',(px*100).toFixed(1)+'%');card.style.setProperty('--light-y',(py*100).toFixed(1)+'%');card.classList.add('is-tilting');}
 }
 function schedule(){if(!frame&&!reduced.matches)frame=requestAnimationFrame(paint);}
 function preferences(){if(reduced.matches){cancelAnimationFrame(frame);frame=0;pointer=null;document.querySelectorAll('.motion-reveal').forEach(reveal);for(const card of tilts)reset(card);document.querySelectorAll('.hero-art,.login-art').forEach(node=>node.style.removeProperty('--parallax'));}else schedule();if(!fine.matches){pointer=null;for(const card of tilts)reset(card);}}
 register(document);
 new MutationObserver(records=>{for(const record of records){for(const node of record.addedNodes)if(node.nodeType===1)register(node);for(const root of record.removedNodes)if(root.nodeType===1){if(root.matches('.motion-reveal'))reveal(root);root.querySelectorAll('.motion-reveal').forEach(reveal);}}for(const card of tilts)if(!card.isConnected){reset(card);tilts.delete(card);observer?.unobserve(card);}schedule();}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});
 document.addEventListener('focusin',event=>{const node=event.target.closest?.('.motion-reveal');if(node)reveal(node);});
 addEventListener('scroll',schedule,{passive:true});addEventListener('resize',schedule,{passive:true});
 reduced.addEventListener('change',preferences);fine.addEventListener('change',preferences);schedule();
}
