(() => {
  'use strict';
  let operatorToken = '';
  let sessionEpoch = 0;
  let activeRefresh = null;
  const $ = id => document.getElementById(id);
  const escapeText = value => String(value ?? '—');
  const setText = (id, value) => { $(id).textContent = escapeText(value); };
  const cell = (tr, value) => { const td = document.createElement('td'); td.textContent = escapeText(value); tr.append(td); return td; };
  const pill = (td, value) => { const span = document.createElement('span'); span.className = 'pill ' + String(value).replace(/[^a-z_]/g, ''); span.textContent = value; td.replaceChildren(span); };
  const empty = (tbody, columns, message) => { tbody.replaceChildren(); const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = columns; td.className = 'empty'; td.textContent = message; tr.append(td); tbody.append(tr); };
  async function request(path, auth = true, { token = operatorToken, signal } = {}) {
    const headers = {};
    if (auth) headers.authorization = 'Bearer ' + token;
    const response = await fetch(path, { headers, cache: 'no-store', credentials: 'same-origin', signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.code || 'http_' + response.status);
    return data;
  }
  async function loadHealth() {
    try { await request('/control/v1/health', false); $('health-dot').className = 'dot ok'; setText('health-label', 'API online'); }
    catch { $('health-dot').className = 'dot bad'; setText('health-label', 'API unavailable'); }
  }
  function filters() {
    const task = new URLSearchParams({limit:'100'});
    if ($('task-status').value) task.set('status', $('task-status').value);
    if ($('task-type').value.trim()) task.set('type', $('task-type').value.trim());
    const participant = new URLSearchParams({limit:'100'});
    if ($('participant-status').value) participant.set('status', $('participant-status').value);
    if ($('participant-kind').value) participant.set('kind', $('participant-kind').value);
    const events = new URLSearchParams({limit:'100'});
    if ($('event-entity').value) events.set('entityType', $('event-entity').value);
    if ($('event-id').value.trim()) events.set('entityId', $('event-id').value.trim());
    return {task, participant, events};
  }
  async function refresh() {
    if (!operatorToken) return;
    const requestEpoch = sessionEpoch;
    const requestToken = operatorToken;
    activeRefresh?.abort();
    const controller = new AbortController();
    activeRefresh = controller;
    const isCurrent = () => requestEpoch === sessionEpoch && activeRefresh === controller && operatorToken === requestToken;
    $('error').textContent = '';
    $('refresh').disabled = true;
    try {
      const q = filters();
      const requestOptions = { token: requestToken, signal: controller.signal };
      const [tasksData, participantsData, eventsData, routingData] = await Promise.all([
        request('/control/v1/tasks?' + q.task, true, requestOptions),
        request('/control/v1/participants?' + q.participant, true, requestOptions),
        request('/control/v1/events?' + q.events, true, requestOptions),
        request('/control/v1/routing/summary', true, requestOptions)
      ]);
      if (!isCurrent()) return;
      const tasks = tasksData.tasks || [], participants = participantsData.participants || [], events = eventsData.events || [];
      const routing = routingData.routing || {};
      const counts = tasks.reduce((acc, task) => { acc[task.status] = (acc[task.status] || 0) + 1; return acc; }, {});
      setText('metric-active', (counts.claimed || 0) + (counts.running || 0) + (counts.cancellation_requested || 0));
      setText('metric-queued', counts.queued || 0);
      setText('metric-blocked', counts.blocked || 0);
      setText('metric-participants', routing.activeClaimParticipants ?? '-');
      setText('metric-unmatched', routing.unmatchedQueuedTasks ?? '-');
      const tb = $('tasks-body'); tb.replaceChildren();
      if (!tasks.length) empty(tb, 6, 'No matching tasks.');
      tasks.forEach(task => {
        const tr = document.createElement('tr'); cell(tr, task.id); cell(tr, task.type); cell(tr, (task.requiredCapabilities || []).join(', ') || 'Any claim-capable participant'); const status = cell(tr, ''); pill(status, task.status);
        cell(tr, task.progress?.percent == null ? '—' : task.progress.percent + '%'); cell(tr, task.updatedAt); tb.append(tr);
      });
      const pb = $('participants-body'); pb.replaceChildren();
      if (!participants.length) empty(pb, 6, 'No matching participants.');
      participants.forEach(person => {
        const tr = document.createElement('tr'); cell(tr, person.displayName); cell(tr, person.kind); const status = cell(tr, ''); pill(status, person.status);
        cell(tr, (person.scopes || []).join(', ') || '-'); cell(tr, (person.capabilities || []).join(', ') || '-'); cell(tr, person.lastSeenAt); pb.append(tr);
      });
      const eb = $('events-body'); eb.replaceChildren();
      if (!events.length) empty(eb, 5, 'No matching events.');
      events.forEach(event => {
        const tr = document.createElement('tr'); cell(tr, event.occurredAt); cell(tr, event.eventType); cell(tr, event.entityType + ':' + event.entityId);
        cell(tr, event.actorParticipantId); cell(tr, event.sequence); eb.append(tr);
      });
      setText('auth-status', 'Connected · data refreshed ' + new Date().toLocaleTimeString());
    } catch (error) {
      if (!isCurrent() || error.name === 'AbortError') return;
      $('error').textContent = 'Could not load dashboard data: ' + error.message;
      if (error.message === 'authentication_required') disconnect('Authentication failed. Check the operator token.');
    } finally {
      if (isCurrent()) {
        activeRefresh = null;
        $('refresh').disabled = false;
      }
    }
  }
  function disconnect(message = 'Disconnected') {
    sessionEpoch++;
    activeRefresh?.abort();
    activeRefresh = null;
    operatorToken = ''; $('operator-token').value = ''; $('refresh').disabled = true;
    setText('auth-status', message);
    empty($('tasks-body'), 6, 'Connect to load tasks.');
    empty($('participants-body'), 6, 'Connect to load participants.');
    empty($('events-body'), 5, 'Connect to load events.');
    $('error').textContent = '';
    ['metric-active','metric-queued','metric-blocked','metric-participants','metric-unmatched'].forEach(id => setText(id, '—'));
  }
  $('auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const token = $('operator-token').value;
    if (token.length < 32 || token.length > 1024 || ![...token].every(character => /[A-Za-z0-9_-]/.test(character))) { disconnect('Token must contain between 32 and 1024 URL-safe ASCII characters (letters, digits, underscore, or hyphen).'); return; }
    sessionEpoch++;
    activeRefresh?.abort();
    activeRefresh = null;
    operatorToken = token;
    $('operator-token').value = ''; $('refresh').disabled = false; setText('auth-status', 'Connecting…'); await refresh();
  });
  $('disconnect').addEventListener('click', () => disconnect());
  $('refresh').addEventListener('click', refresh);
  ['task-status','participant-status','participant-kind','event-entity'].forEach(id => $(id).addEventListener('change', refresh));
  ['task-type','event-id'].forEach(id => $(id).addEventListener('change', refresh));
  loadHealth();
  setInterval(loadHealth, 15000);
})();
