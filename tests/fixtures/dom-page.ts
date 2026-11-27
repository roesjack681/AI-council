/** Browser fixtures exercise DOM mechanics. They never contact or impersonate a real model. */
export function providerPage(
  platform: 'deepseek' | 'gemini' | 'doubao' | 'chatgpt',
  options: {
    loggedOut?: boolean;
    challenge?: boolean;
    seed?: boolean;
    resetDelayMs?: number;
    unlabeledNewChat?: boolean;
    router?: boolean;
    plainReply?: string;
  } = {},
): string {
  const editor =
    platform === 'gemini' || platform === 'doubao' || platform === 'chatgpt'
      ? `<div id="${platform === 'chatgpt' ? 'prompt-textarea' : 'editor'}" role="textbox" contenteditable="true" style="white-space:pre-wrap;border:1px solid;padding:10px;min-height:50px"></div>`
      : '<textarea placeholder="给 DeepSeek 发送消息"></textarea>';
  const output = (id: string, raw: string) =>
    platform === 'gemini'
      ? `<div id="model-response-message-content${id}"><pre>${raw}</pre></div>`
      : platform === 'deepseek'
        ? `<div class="ds-markdown"><pre>${raw}</pre></div>`
        : platform === 'chatgpt'
          ? `<div data-message-author-role="assistant"><div class="markdown"><pre>${raw}</pre></div></div>`
          : `<div data-testid="message_text_content"><pre>${raw}</pre></div>`;
  const welcome =
    platform === 'deepseek' && options.seed === false
      ? '<div id="welcome">早上好，开始聊天吧</div>'
      : platform === 'chatgpt' && options.seed === false
        ? '<h1 id="welcome">What can I help with?</h1>'
        : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>TEST DOM FIXTURE - ${platform}</title></head><body><h1>${options.challenge ? 'Verify you are human' : 'TEST DOM FIXTURE ONLY'}</h1>${options.loggedOut ? '<button>登录</button>' : ''}<main>${welcome}<section id="messages">${options.seed === false ? '' : output('seed', 'TEST STRUCTURAL SAMPLE') + '<button aria-label="复制">Copy</button>'}</section><div id="input-engine-container">${editor}</div><button aria-label="发送消息" data-testid="send-button" id="send">Send</button></main><script>
  const input=document.querySelector('textarea,[contenteditable]');let sequence=0;
  const newChat=document.createElement(${options.unlabeledNewChat ? "'div'" : "'button'"});newChat.id='new-chat';newChat.dataset.clicks='0';
  if(${options.unlabeledNewChat ?? false}){newChat.className='ds-button';newChat.setAttribute('role','button');newChat.tabIndex=0;newChat.style.cssText='width:44px;height:44px';newChat.innerHTML='<svg viewBox="0 0 20 20"><path d="M9.99994 1.22943C5.15598 1.22943 1.22937 5.15604 1.22937 10Z M9.21913 6.36949V9.22487H6.36943V10.7751H9.21913V13.6305H10.7694V10.7751H13.6304V9.22487H10.7694V6.36949H9.21913Z"></path></svg>';const header=document.createElement('div');header.className='the-header';header.append(newChat);document.querySelector('main').prepend(header);}else{newChat.title='New chat';newChat.textContent='↻';document.querySelector('main').prepend(newChat);}
  newChat.addEventListener('click',()=>{newChat.dataset.clicks=String(Number(newChat.dataset.clicks)+1);setTimeout(()=>{document.querySelector('#messages').replaceChildren();if('value' in input)input.value='';else input.textContent='';},${options.resetDelayMs ?? 0});});
  const escaped=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const output=${JSON.stringify(platform)};
  document.querySelector('#send').addEventListener('click',()=>{
    const prompt='value' in input?input.value:input.innerText;if(!prompt.trim())return;
    document.querySelector('#welcome')?.remove();
    if('value' in input)input.value='';else input.textContent='';
    sequence++;const user=document.createElement('div');user.setAttribute('data-message-author-role','user');user.id='user-query-content-'+sequence;user.textContent=prompt;document.querySelector('#messages').append(user);
    const contextLine=prompt.split('\\n').find(line=>line.startsWith('当前实体（ID、版本与立场）：'));
    let claims=[];if(contextLine)claims=JSON.parse(contextLine.slice(contextLine.indexOf('：')+1)).claims;
    const response=${options.router ?? false}?{intent:'direct_ask',targets:[document.body.dataset.routeTarget],task:'TEST ROUTER GUIDANCE',brief:'TEST DOM FIXTURE: route to the designated member.',reason:'TEST ROUTER ONLY'}:{type:contextLine?'FINAL_POSITION':'INITIAL_ANSWER',brief:'TEST DOM FIXTURE: agree with the proposal under test.',content:'TEST DOM FIXTURE ONLY: generated from the current prompt for transport testing.',claims:contextLine?[]:[{key:'fixture-proposal',description:'TEST DOM FIXTURE proposal '+output,category:'recommendation',critical:false}],positions:claims.map(c=>({claimId:c.id,version:c.version,position:'AGREE',reason:'TEST DOM FIXTURE rationale for this exact version',final:true,conditions:[]})),objections:[],resolutions:[]};
    const raw=${JSON.stringify(options.plainReply ?? null)}??JSON.stringify(response);const node=document.createElement('div');if(output==='gemini')node.id='model-response-message-content'+sequence;else if(output==='deepseek')node.className='ds-markdown';else if(output==='doubao')node.setAttribute('data-testid','message_text_content');else node.setAttribute('data-message-author-role','assistant');const pre=document.createElement('pre');if(output==='chatgpt')pre.className='markdown';pre.textContent=raw;node.append(pre);document.querySelector('#messages').append(node);const copy=document.createElement('button');copy.setAttribute('aria-label','复制');copy.textContent='Copy';document.querySelector('#messages').append(copy);
  });
  </script></body></html>`;
}
