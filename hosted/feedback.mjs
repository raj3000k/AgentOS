// Immediate local feedback; never starts or repeats an application action.
export function initFeedback(){
 const saved=new WeakMap();
 function busy(button){if(!button.matches('button[data-busy-label]'))return;
  if(button.disabled&&!saved.has(button)){saved.set(button,[...button.childNodes]);const spinner=document.createElement('span');spinner.className='button-spinner';spinner.setAttribute('aria-hidden','true');button.replaceChildren(spinner,document.createTextNode(button.dataset.busyLabel));button.setAttribute('aria-busy','true');}
  else if(!button.disabled&&saved.has(button)){button.replaceChildren(...saved.get(button));saved.delete(button);button.removeAttribute('aria-busy');}
 }
 new MutationObserver(records=>{for(const record of records)busy(record.target);}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['disabled']});
 document.querySelectorAll('button[data-busy-label]').forEach(busy);
 document.addEventListener('click',event=>{const button=event.target.closest?.('button');if(!button||button.disabled)return;button.classList.remove('tap-feedback');requestAnimationFrame(()=>{button.classList.add('tap-feedback');setTimeout(()=>button.classList.remove('tap-feedback'),240);});});
}

let toastTimer;
export function notify(message){const toast=document.getElementById('action-toast');if(!toast)return;clearTimeout(toastTimer);toast.textContent=message;toast.hidden=false;toastTimer=setTimeout(()=>{toast.hidden=true;},3500);}
