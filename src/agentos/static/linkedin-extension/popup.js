document.getElementById('connect').onclick = async () => {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  const code = document.getElementById('code').value.trim();
  if (!tab || !/^https:\/\/www\.linkedin\.com\//.test(tab.url || '') || !/^[\w-]{40,100}$/.test(code)) {
    document.getElementById('status').textContent = 'Choose a www.linkedin.com tab and enter the AgentOS pairing code.'; return;
  }
  await chrome.runtime.sendMessage({type:'connect',tabId:tab.id,code});
  document.getElementById('code').value = '';
  document.getElementById('status').textContent = 'Tab selected. Check connection status in AgentOS.';
};
document.getElementById('disconnect').onclick = async () => {
  await chrome.runtime.sendMessage({type:'disconnect'});
  document.getElementById('status').textContent = 'Disconnected.';
};
