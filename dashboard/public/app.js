// rigs-dashboard client — keep first paint as the server-rendered HTML, then
// stream snapshots over SSE and rewrite agent dots / bead lists in place.

(function () {
  const tokenMatch = window.location.search.match(/[?&]token=([^&]+)/);
  const tokenQuery = tokenMatch ? '?token=' + tokenMatch[1] : '';
  const updatedEl = document.getElementById('updated');

  function statusDot(running, hasWork) {
    if (running && hasWork) return 'green';
    if (running) return 'yellow';
    return 'red';
  }

  function flattenAgents(status) {
    const all = [];
    if (status && Array.isArray(status.agents)) {
      for (const a of status.agents) all.push(a);
    }
    if (status && Array.isArray(status.rigs)) {
      for (const rig of status.rigs) {
        if (Array.isArray(rig.agents)) {
          for (const a of rig.agents) all.push(a);
        }
      }
    }
    return all;
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function renderBeadRow(b) {
    const id = escHtml(b.id);
    const title = escHtml((b.title || '').slice(0, 120));
    const prio = b.priority != null ? 'P' + b.priority : '';
    const assignee = escHtml(b.assignee || '');
    return (
      '<li class="bead">' +
      '<span class="bead-id">' + id + '</span>' +
      (prio ? '<span class="prio prio-' + escHtml(String(b.priority)) + '">' + escHtml(prio) + '</span>' : '') +
      '<span class="bead-title">' + title + '</span>' +
      (assignee ? '<span class="bead-assignee">' + assignee + '</span>' : '') +
      '</li>'
    );
  }

  function applySnapshot(snap) {
    const status = snap.status || {};
    const agents = flattenAgents(status);

    // Refresh the dot + work flag for each rendered agent. Agents are keyed
    // by session so the order in the DOM doesn't have to match the snapshot.
    const liNodes = document.querySelectorAll('li.agent');
    const bySession = {};
    for (const a of agents) if (a.session) bySession[a.session] = a;

    liNodes.forEach((li) => {
      const session = (li.querySelector('.agent-session') || {}).textContent;
      if (!session) return;
      const a = bySession[session];
      if (!a) return;
      const dot = li.querySelector('.dot');
      if (dot) {
        dot.classList.remove('dot-green', 'dot-yellow', 'dot-red');
        dot.classList.add('dot-' + statusDot(a.running, a.has_work));
        dot.title = a.running ? 'running' : 'stopped';
      }
      let flag = li.querySelector('.work-flag');
      if (a.has_work && !flag) {
        flag = document.createElement('span');
        flag.className = 'work-flag';
        flag.textContent = 'hooked';
        li.appendChild(flag);
      } else if (!a.has_work && flag) {
        flag.remove();
      }
      const pane = li.querySelector('.pane');
      const newPane = (snap.panes || {})[session];
      if (pane && newPane) pane.textContent = newPane;
    });

    // Rewrite bead lists. Section headings carry semantic data-bucket values
    // (work-in-progress / queue / closed) so we don't have to string-match on
    // display text — that lets the design iterate without breaking the
    // client.
    const beadSections = document.querySelectorAll('section.beads');
    beadSections.forEach((sec) => {
      const bucket = sec.getAttribute('data-bucket');
      const h = sec.querySelector('h2');
      const ul = sec.querySelector('ul.bead-list');
      if (!h || !ul) return;
      let rows = null;
      let count = null;
      let emptyLabel = 'none';
      if (bucket === 'in-progress') {
        rows = (snap.beads || {}).in_progress || [];
        count = rows.length;
        emptyLabel = 'idle';
      } else if (bucket === 'ready') {
        const all = (snap.beads || {}).ready || [];
        rows = all.slice(0, 30);
        count = all.length;
        emptyLabel = 'empty';
      } else if (bucket === 'closed') {
        rows = (snap.beads || {}).recent_closed || [];
        count = null; // no count badge
      }
      if (rows == null) return;
      const countEl = h.querySelector('.rig-counts');
      if (countEl && count != null) countEl.textContent = String(count);
      ul.innerHTML = rows.length
        ? rows.map(renderBeadRow).join('')
        : '<li class="empty">' + emptyLabel + '</li>';
    });

    if (updatedEl && snap.generated_at) {
      updatedEl.textContent = snap.generated_at;
    }
  }

  function connect() {
    const es = new EventSource('/events' + tokenQuery);
    es.addEventListener('snapshot', (ev) => {
      try { applySnapshot(JSON.parse(ev.data)); }
      catch (_) { /* ignore */ }
    });
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do but reflect staleness.
      if (updatedEl) updatedEl.classList.add('stale');
    };
  }

  if (typeof EventSource !== 'undefined') {
    connect();
  }
})();
