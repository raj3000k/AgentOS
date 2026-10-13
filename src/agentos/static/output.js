/* A small Markdown subset built with DOM nodes; model HTML is never interpreted. */
(() => {
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  function linkURL(value) {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  function inline(parent, text, depth = 0) {
    if (depth > 4) { parent.append(document.createTextNode(text)); return; }
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\)|https?:\/\/[^\s<>]+)/g;
    let offset = 0;
    let match;
    while ((match = pattern.exec(text))) {
      parent.append(document.createTextNode(text.slice(offset, match.index)));
      const token = match[0];
      if (token.startsWith('`')) parent.append(node('code', token.slice(1, -1)));
      else if (token.startsWith('**') || token.startsWith('__')) {
        const strong = node('strong'); inline(strong, token.slice(2, -2), depth + 1); parent.append(strong);
      } else if (token.startsWith('*')) {
        const em = node('em'); inline(em, token.slice(1, -1), depth + 1); parent.append(em);
      } else {
        const markdown = /^\[([^\]]+)\]\((.+)\)$/.exec(token);
        const target = markdown ? markdown[2] : token.replace(/[.,;!?)]+$/, '');
        const url = linkURL(target);
        if (!url || (markdown && text[match.index - 1] === '!')) parent.append(document.createTextNode(token));
        else {
          const anchor = node('a', markdown ? markdown[1] : target);
          anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
          anchor.title = 'Link from the answer; check source evidence for verification.';
          parent.append(anchor);
          if (!markdown) parent.append(document.createTextNode(token.slice(target.length)));
        }
      }
      offset = pattern.lastIndex;
    }
    parent.append(document.createTextNode(text.slice(offset)));
  }
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(value => value.trim().replace(/\\\|/g, '|'));
  const separator = line => cells(line).length > 0 && cells(line).every(value => /^:?-{3,}:?$/.test(value));
  function download(text, filename, mime = 'text/plain;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([text], {type:mime}));
    const anchor = node('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function copy(text, button) {
    const original = button.textContent;
    try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; }
    catch { button.textContent = 'Copy unavailable'; }
    setTimeout(() => { button.textContent = original; }, 1500);
  }
  function tableBlock(headers, rows, alignments) {
    const wrap = node('section', undefined, 'answer-table');
    const toolbar = node('div', undefined, 'table-toolbar');
    const filter = node('input'); filter.type = 'search'; filter.placeholder = 'Filter rows…'; filter.setAttribute('aria-label', 'Filter answer table rows');
    const count = node('span', `${rows.length} rows`);
    const exportButton = node('button', 'Download CSV', 'text-button'); exportButton.type = 'button';
    const state = rows.map((row, index) => ({row, index}));
    let current = state.slice();
    let sortColumn = -1; let direction = 1;
    const scroll = node('div', undefined, 'table-scroll'); scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Answer table; scroll horizontally if needed');
    const table = node('table'); const head = node('thead'); const heading = node('tr'); const body = node('tbody');
    const headingCells = [];
    headers.forEach((header, index) => {
      const th = node('th'); th.scope = 'col'; th.setAttribute('aria-sort', 'none');
      const button = node('button', header + ' ↕'); button.type = 'button'; button.setAttribute('aria-label', `Sort by ${header}`);
      button.addEventListener('click', () => { direction = sortColumn === index ? -direction : 1; sortColumn = index; refresh(); });
      th.append(button); heading.append(th); headingCells.push(th);
    });
    head.append(heading); table.append(head, body); scroll.append(table);
    function refresh() {
      const query = filter.value.toLowerCase();
      current = state.filter(entry => entry.row.join(' ').toLowerCase().includes(query));
      if (sortColumn >= 0) current.sort((a, b) => {
        const left = a.row[sortColumn] || ''; const right = b.row[sortColumn] || '';
        const numeric = left.trim() !== '' && right.trim() !== '' && Number.isFinite(Number(left)) && Number.isFinite(Number(right));
        return direction * (numeric ? Number(left) - Number(right) : left.localeCompare(right, undefined, {numeric:true}));
      });
      headingCells.forEach((th, index) => th.setAttribute('aria-sort', index === sortColumn ? direction === 1 ? 'ascending' : 'descending' : 'none'));
      body.replaceChildren();
      for (const entry of current) {
        const tr = node('tr');
        headers.forEach((_, index) => { const td = node('td'); inline(td, entry.row[index] || ''); td.className = alignments[index] || ''; tr.append(td); });
        body.append(tr);
      }
      count.textContent = `${current.length} of ${rows.length} rows`;
      if (!current.length) { const tr = node('tr'); const td = node('td', 'No matching rows.'); td.colSpan = headers.length; tr.append(td); body.append(tr); }
    }
    filter.addEventListener('input', refresh);
    exportButton.addEventListener('click', () => {
      const csvCell = value => { const safe = /^(?:\s*[=+\-@]|[\t\r])/.test(value) ? "'" + value : value; return '"' + safe.replace(/"/g, '""') + '"'; };
      const csv = [headers, ...current.map(entry => entry.row)].map(row => row.map(csvCell).join(',')).join('\r\n');
      download(csv, 'agentos-table.csv', 'text/csv;charset=utf-8');
    });
    toolbar.append(filter, count, exportButton); wrap.append(toolbar, scroll); refresh(); return wrap;
  }
  function render(container, source) {
    container.replaceChildren();
    const text = String(source).slice(0, 100000);
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    let index = 0; let blocks = 0;
    function startsBlock(line, next) {
      return /^(\s*$|#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|>\s?|\s*```|\s*~~~|\s*([-*_])(?:\s*\2){2,}\s*$)/.test(line) || (line.includes('|') && next && separator(next));
    }
    while (index < lines.length && blocks++ < 1000) {
      const line = lines[index];
      if (!line.trim()) { index++; continue; }
      const fence = /^\s*(`{3,}|~{3,})([^\s]*)\s*$/.exec(line);
      if (fence) {
        index++; const codeLines = [];
        while (index < lines.length && !lines[index].trim().startsWith(fence[1])) codeLines.push(lines[index++]);
        if (index < lines.length) index++;
        const block = node('div', undefined, 'code-block'); const toolbar = node('div', undefined, 'code-toolbar');
        const button = node('button', 'Copy code', 'text-button'); button.type = 'button'; const codeText = codeLines.join('\n');
        button.addEventListener('click', () => copy(codeText, button));
        toolbar.append(node('span', fence[2].slice(0, 24) || 'Code'), button);
        const pre = node('pre'); pre.append(node('code', codeText)); block.append(toolbar, pre); container.append(block); continue;
      }
      const header = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (header) { const h = node(`h${header[1].length}`); inline(h, header[2]); container.append(h); index++; continue; }
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { container.append(node('hr')); index++; continue; }
      if (line.includes('|') && index + 1 < lines.length && separator(lines[index + 1]) && cells(line).length === cells(lines[index + 1]).length) {
        const headers = cells(line); const marks = cells(lines[index + 1]); const rows = []; index += 2;
        let truncatedRows = false;
        while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
          if (rows.length < 300) rows.push(cells(lines[index])); else truncatedRows = true;
          index++;
        }
        const alignments = marks.map(mark => mark.startsWith(':') && mark.endsWith(':') ? 'align-center' : mark.endsWith(':') ? 'align-right' : '');
        container.append(tableBlock(headers, rows, alignments));
        if (truncatedRows) container.append(node('p', 'Table preview limited to 300 rows. Raw Markdown retains every row; CSV exports the visible filtered rows.', 'format-note'));
        continue;
      }
      const list = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(line);
      if (list) {
        const ordered = /^\d/.test(list[2]); const root = node(ordered ? 'ol' : 'ul');
        if (ordered) root.start = parseInt(list[2], 10);
        const stack = [{indent:list[1].length, list:root, last:null}];
        while (index < lines.length) {
          const item = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(lines[index]);
          if (!item) break;
          const indent = item[1].length;
          while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();
          let current = stack[stack.length - 1];
          if (indent > current.indent && current.last) { const nested = node(/^\d/.test(item[2]) ? 'ol' : 'ul'); current.last.append(nested); current = {indent, list:nested, last:null}; stack.push(current); }
          if (indent === stack[0].indent && ordered !== /^\d/.test(item[2])) break;
          const li = node('li'); const task = /^\[([ xX])\]\s+(.+)$/.exec(item[3]);
          if (task) { const label = node('label', undefined, 'answer-task'); const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = task[1].toLowerCase() === 'x'; const span = node('span'); inline(span, task[2]); label.append(checkbox, span); li.append(label); }
          else inline(li, item[3]);
          current.list.append(li); current.last = li; index++;
        }
        container.append(root); continue;
      }
      if (/^>\s?/.test(line)) {
        const quote = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
        const block = node('blockquote'); inline(block, quote.join('\n')); container.append(block); continue;
      }
      const paragraph = [line]; index++;
      while (index < lines.length && !startsBlock(lines[index], lines[index + 1])) paragraph.push(lines[index++]);
      const p = node('p'); inline(p, paragraph.join('\n')); container.append(p);
    }
    if (source.length > 100000 || index < lines.length) container.append(node('p', 'Preview shortened. Raw view and Markdown download retain the full answer.', 'format-note'));
  }
  window.AgentOSOutput = {render, linkURL, download};
})();
