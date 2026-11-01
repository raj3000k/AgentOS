const $=id=>document.getElementById(id);
export const runningStatuses=['ready','working','waiting_browser'];
export const statusNames={awaiting_approval:'Review your plan',ready:'Ready for the next step',working:'Your agent is working',waiting_browser:'Reading the connected tab',paused:'Paused at a checkpoint',completed:'Response ready',budget_summary:'Budget summary ready',partial:'Interrupted · evidence saved',cancelled:'Stopped'};
export function renderWorkflow(run){
 const workflow=run.workflow;if(!workflow){$('workflow-progress').hidden=true;return;}
 $('workflow-progress').hidden=false;
 $('workflow-task').textContent=run.prompt;
 $('workflow-meta').textContent=`Checkpoint ${workflow.checkpoint.number} · ${run.model_calls}/6 model attempts · retained until ${new Date(run.expiresAt).toLocaleDateString()}`;
 $('execution-plan').replaceChildren();
 for(const [index,step] of workflow.plan.entries()){
  const li=document.createElement('li'),heading=document.createElement('strong'),detail=document.createElement('p'),marker=document.createElement('span');
  const delivered=['completed','budget_summary'].includes(run.status),approved=workflow.reviewed;
  const phase=index===0?(approved?'reviewed':'review'):index===1?(delivered?'attempted':runningStatuses.includes(run.status)?'active':'pending'):(delivered?'delivered':'pending');
  li.dataset.state=phase;marker.className='phase-marker';marker.textContent=String(index+1).padStart(2,'0');heading.textContent=step.title;detail.textContent=step.detail;const text=document.createElement('div');text.append(heading,detail);li.append(marker,text);$('execution-plan').append(li);
 }
 $('workflow-note').textContent=run.status==='awaiting_approval'?'Review this execution outline. Approving starts model and tool work with the capabilities shown above. Retrieval may already have used an embedding request.':workflow.pauseRequested?'Pause requested. The current read may finish; no further step will start.':'Each finished batch is saved. Closing this page stops client-driven execution after the in-flight batch; open it from Run history to continue. Resuming uses captured evidence, which may be stale.';
 $('approve-run').hidden=run.status!=='awaiting_approval';
 $('pause-run').hidden=!runningStatuses.includes(run.status);$('pause-run').disabled=workflow.pauseRequested;
 const interruptedLease=run.status==='working'&&workflow.leaseUntil&&workflow.leaseUntil<=Date.now();
 const expiredBrowser=run.status==='waiting_browser'&&run.pendingBrowser?.expiresAt<=Date.now();
 $('resume-run').hidden=!(workflow.canResume||interruptedLease||expiredBrowser);
 $('check-run').hidden=!['working','waiting_browser','ready'].includes(run.status);
 $('workflow-timeline').replaceChildren();
 for(const item of workflow.timeline){const li=document.createElement('li'),time=document.createElement('time'),label=document.createElement('span');time.dateTime=new Date(item.at).toISOString();time.textContent=new Date(item.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});label.textContent=item.label;li.dataset.type=item.type;li.append(time,label);$('workflow-timeline').append(li);}
 $('checkpoint-evidence').replaceChildren();
 for(const item of run.evidence||[]){const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent=item.name;pre.textContent=JSON.stringify(item.result,null,2);details.append(summary,pre);$('checkpoint-evidence').append(details);}
 if(!run.evidence?.length){const empty=document.createElement('p');empty.className='hint';empty.textContent='No tool or reference evidence collected yet.';$('checkpoint-evidence').append(empty);}
 $('completion-checks').replaceChildren();
 for(const check of workflow.checks){const li=document.createElement('li'),label=document.createElement('strong'),detail=document.createElement('span'),state=document.createElement('small');li.dataset.state=check.state;label.textContent=check.label;state.textContent=check.state==='review'?'Needs your review':check.state;detail.textContent=check.detail;li.append(label,state,detail);$('completion-checks').append(li);}
}
