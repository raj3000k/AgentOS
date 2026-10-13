const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Element {
  constructor(tag, text = '') { this.tagName = tag; this.children = []; this.events = {}; this.attributes = {}; this.value = ''; this._text = text; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, callback) { this.events[name] = callback; }
  click() { this.events.click?.(); }
  remove() {}
}
const document = {createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text), body: new Element('body')};
const downloads = [];
class TestURL extends URL {}
TestURL.createObjectURL = blob => { downloads.push(blob); return 'blob:test'; };
TestURL.revokeObjectURL = () => {};
const window = {};
vm.runInNewContext(fs.readFileSync(process.argv[2], 'utf8'), {window, document, URL:TestURL, Blob, navigator:{clipboard:{writeText:async () => {}}}, setTimeout:()=>0});
const {render, linkURL} = window.AgentOSOutput;
function elements(root, tag) { return [...(root.tagName === tag ? [root] : []), ...root.children.flatMap(child => elements(child, tag))]; }
const root = new Element('div');
render(root, '# Results\n\n**Strong** and *emphasis* with `code`.\n\n- First\n  - Nested\n- [ ] Review this\n\n> Evidence matters\n\n```python\nprint("hello")\n```');
assert.equal(elements(root, 'h1')[0].textContent, 'Results');
assert.equal(elements(root, 'strong')[0].textContent, 'Strong');
assert.equal(elements(root, 'em')[0].textContent, 'emphasis');
assert.equal(elements(root, 'ul').length, 2);
assert.equal(elements(root, 'input')[0].type, 'checkbox');
assert.equal(elements(root, 'pre')[0].textContent, 'print("hello")');
assert.equal(elements(root, 'blockquote')[0].textContent, 'Evidence matters');
render(root, '<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [credentials](https://key:secret@example.com) [good](https://example.com/job)\n\n![pixel](https://example.com/track.png)');
assert.equal(elements(root, 'img').length, 0);
assert.equal(elements(root, 'script').length, 0);
assert.equal(elements(root, 'a').length, 1);
assert.equal(elements(root, 'a')[0].href, 'https://example.com/job');
assert.equal(elements(root, 'a')[0].rel, 'noopener noreferrer');
assert.equal(linkURL('data:text/html,bad'), null);
render(root, '| Company | Experience |\n| --- | ---: |\n| Beta | 10 |\n| Alpha | 2 |\n| =SUM(A1) | 1 |');
const table = elements(root, 'table')[0];
const body = elements(root, 'tbody')[0];
const sort = elements(table, 'button')[1];
sort.click();
assert.equal(body.children[0].children[1].textContent, '1');
sort.click();
assert.equal(body.children[0].children[1].textContent, '10');
const filter = elements(root, 'input')[0];
filter.value = 'alpha'; filter.events.input();
assert.equal(body.children.length, 1);
assert.equal(body.children[0].children[0].textContent, 'Alpha');
filter.value = ''; filter.events.input();
const csvButton = elements(root, 'button').find(button => button.textContent === 'Download CSV');
csvButton.click();
(async () => {
  const csv = await downloads[0].text();
  assert.ok(csv.includes("\"'=SUM(A1)\""));
  render(root, '| Item |\n| --- |\n' + Array.from({length:301}, (_,index) => '| ' + index + ' |').join('\n'));
  assert.equal(elements(root, 'tbody')[0].children.length, 300);
  assert.ok(root.textContent.includes('Table preview limited'));
  render(root, 'x'.repeat(100001));
  assert.ok(root.textContent.includes('Preview shortened'));
  console.log('Renderer formatting, inert HTML, safe links, table filter/sort/CSV and preview limits passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
