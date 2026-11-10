(() => {
  'use strict';
  let operatorToken = '';
  let sessionEpoch = 0;
  let activeRefresh = null;
  let inspectedTaskId = '';
  let inspectedParticipantId = '';
  const BLOCK_EVENTS = new Set(['task.lease_expired_blocked', 'task.participant_revoked_blocked']);
  const $ = id => document.getElementById(id);
  const escapeText = value => String(value ?? '—');
  const setText = (id, value) => { $(id).textContent = escapeText(value); };
  const cell = (tr, value) => { const td = document.createElement('td'); td.textContent = escapeText(value); tr.append(td); return td; };
  const pill = (td, value) => { const span = document.createElement('span'); span.className = 'pill ' + String(value).replace(/[^a-z_]/g, ''); span.textContent = value; td.replaceChildren(span); };
  const empty = (tbody, columns, message) => { tbody.replaceChildren(); const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = columns; td.className = 'empty'; td.textContent = message; tr.append(td); tbody.append(tr); };
  async function request(path, auth = true, { token = operatorToken, signal, method = 'GET', body } = {}) {
    const headers = {};
    if (auth) headers.authorization = 'Bearer ' + token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'same-origin', signal });
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
  function closeInspector() {
    inspectedTaskId = '';
    $('task-inspector').hidden = true;
    $('recovery-reason').value = '';
    $('confirm-worker-stopped').checked = false;
    $('confirm-side-effects').checked = false;
    $('requeue-task').disabled = true;
    $('inspector-events').replaceChildren();
    $('recovery-panel').hidden = true;
    $('inspector-error').textContent = '';
    $('recovery-status').textContent = '';
  }
  function closeParticipantInspector() {
    inspectedParticipantId = '';
    $('participant-inspector').hidden = true;
    $('participant-events').replaceChildren();
    $('participant-inspector-error').textContent = '';
  }
  function participantEventDetails(event) {
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    if (event.eventType === 'participant.revoked') {
      const ids = Array.isArray(data.blockedTaskIds) ? data.blockedTaskIds : [];
      return ids.length ? 'Blocked tasks (' + ids.length + '): ' + ids.join(', ') : 'Revoked; no active tasks were blocked.';
    }
    if (event.eventType === 'participant.capabilities_updated') {
      const previous = Array.isArray(data.previousCapabilities) ? data.previousCapabilities : [];
      const current = Array.isArray(data.capabilities) ? data.capabilities : [];
      return 'Previous: [' + previous.join(', ') + '] → Current: [' + current.join(', ') + ']; affects future claims only.';
    }
    if (event.eventType === 'participant.registered') {
      const scopes = Array.isArray(data.scopes) ? data.scopes : [];
      const capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
      return 'Registered; scopes: [' + scopes.join(', ') + ']; capabilities: [' + capabilities.join(', ') + '].';
    }
    return 'No additional participant detail recorded.';
  }
  async function inspectParticipant(participantId) {
    if (!operatorToken) return;
    const epoch = sessionEpoch, token = operatorToken;
    inspectedParticipantId = participantId;
    $('participant-inspector').hidden = false;
    $('participant-inspector-error').textContent = '';
    setText('participant-summary', 'Loading participant ' + participantId + '…');
    empty($('participant-events'), 4, 'Loading participant history…');
    $('participant-inspector').scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    try {
      const [participantData, eventData] = await Promise.all([
        request('/control/v1/participants/' + encodeURIComponent(participantId), true, {token}),
        request('/control/v1/events?' + new URLSearchParams({entityType:'participant', entityId:participantId, limit:'100'}), true, {token})
      ]);
      if (epoch !== sessionEpoch || token !== operatorToken || inspectedParticipantId !== participantId) return;
      const person = participantData.participant;
      const events = eventData.events || [];
      setText('participant-summary', person.displayName + ' · ' + person.id);
      setText('participant-detail-status', person.status);
      setText('participant-detail-kind', person.kind);
      setText('participant-detail-scopes', (person.scopes || []).join(', ') || 'None');
      setText('participant-detail-capabilities', (person.capabilities || []).join(', ') || 'None');
      setText('participant-detail-created', person.createdAt);
      setText('participant-detail-updated', person.updatedAt);
      setText('participant-detail-last-seen', person.lastSeenAt || 'Never');
      const body = $('participant-events');
      body.replaceChildren();
      if (!events.length) empty(body, 4, 'No participant audit events found.');
      events.forEach(event => {
        const tr = document.createElement('tr');
        cell(tr, event.occurredAt);
        cell(tr, event.eventType);
        const details = cell(tr, participantEventDetails(event));
        details.className = 'participant-events-details';
        cell(tr, event.sequence);
        body.append(tr);
      });
    } catch (error) {
      if (epoch !== sessionEpoch || token !== operatorToken || error.name === 'AbortError') return;
      setText('participant-inspector-error', 'Could not inspect participant: ' + error.message);
    }
  }
  function updateRequeueButton() {
    $('requeue-task').disabled = !$('recovery-reason').value.trim()
      || !$('confirm-worker-stopped').checked || !$('confirm-side-effects').checked;
  }
  async function inspectTask(taskId) {
    if (!operatorToken) return;
    const epoch = sessionEpoch, token = operatorToken;
    inspectedTaskId = taskId;
    $('task-inspector').hidden = false;
    $('recovery-panel').hidden = true;
    $('inspector-error').textContent = '';
    setText('inspector-summary', 'Loading task ' + taskId + '…');
    empty($('inspector-events'), 4, 'Loading event history…');
    $('task-inspector').scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    try {
      const [taskData, eventData] = await Promise.all([
        request('/control/v1/tasks/' + encodeURIComponent(taskId) + '/summary', true, {token}),
        request('/control/v1/events?' + new URLSearchParams({entityType:'task', entityId:taskId, limit:'50'}), true, {token})
      ]);
      if (epoch !== sessionEpoch || token !== operatorToken || inspectedTaskId !== taskId) return;
      const task = taskData.task;
      const events = eventData.events || [];
      setText('inspector-summary', 'Task ' + task.id + ' · ' + task.type + ' · status: ' + task.status);
      const body = $('inspector-events'); body.replaceChildren();
      if (!events.length) empty(body, 4, 'No task events found.');
      events.forEach(event => {
        const tr = document.createElement('tr');
        cell(tr, event.occurredAt); cell(tr, event.eventType); cell(tr, event.actorParticipantId || 'system'); cell(tr, event.sequence);
        body.append(tr);
      });
      const latest = events[0];
      if (task.status === 'blocked' && latest && BLOCK_EVENTS.has(latest.eventType)) {
        $('recovery-panel').hidden = false;
        setText('recovery-block-event', 'Latest blocking event: ' + latest.eventType + ' · ' + latest.occurredAt + ' · sequence ' + latest.sequence);
        $('recovery-reason').value = '';
        $('confirm-worker-stopped').checked = false;
        $('confirm-side-effects').checked = false;
        updateRequeueButton();
      } else {
        $('recovery-panel').hidden = true;
        setText('inspector-error', task.status !== 'blocked'
          ? 'Recovery is available only while the task is blocked.'
          : 'No recognized latest blocking event. Requeue is unavailable for this history.');
      }
    } catch (error) {
      if (epoch !== sessionEpoch || token !== operatorToken || error.name === 'AbortError') return;
      setText('inspector-error', 'Could not inspect task: ' + error.message);
    }
  }
  async function requeueTask() {
    const taskId = inspectedTaskId;
    if (!taskId || !operatorToken || $('requeue-task').disabled) return;
    const epoch = sessionEpoch, token = operatorToken;
    const reason = $('recovery-reason').value.trim();
    $('requeue-task').disabled = true;
    setText('recovery-status', 'Submitting operator recovery…');
    $('inspector-error').textContent = '';
    try {
      const result = await request('/control/v1/tasks/' + encodeURIComponent(taskId) + '/requeue', true, {
        token, method:'POST',
        body: { reason, confirmWorkerStopped:$('confirm-worker-stopped').checked, confirmSideEffectsReviewed:$('confirm-side-effects').checked }
      });
      if (epoch !== sessionEpoch || token !== operatorToken || inspectedTaskId !== taskId) return;
      setText('recovery-status', 'Requeued. New status: ' + result.task.status);
      $('recovery-panel').hidden = true;
      await refresh();
      if (epoch === sessionEpoch && token === operatorToken) await inspectTask(taskId);
    } catch (error) {
      if (epoch !== sessionEpoch || token !== operatorToken) return;
      setText('inspector-error', 'Requeue rejected: ' + error.message + '. Refresh and inspect the task before trying again.');
      updateRequeueButton();
    }
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
        request('/control/v1/tasks/summary?' + q.task, true, requestOptions),
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
      if (!tasks.length) empty(tb, 7, 'No matching tasks.');
      tasks.forEach(task => {
        const tr = document.createElement('tr');
        cell(tr, task.id); cell(tr, task.type); cell(tr, (task.requiredCapabilities || []).join(', ') || 'Any claim-capable participant');
        const status = cell(tr, ''); pill(status, task.status);
        cell(tr, task.progress?.percent == null ? '—' : task.progress.percent + '%'); cell(tr, task.updatedAt);
        const action = document.createElement('td');
        if (task.status === 'blocked') {
          const inspect = document.createElement('button'); inspect.type = 'button'; inspect.className = 'secondary compact';
          inspect.textContent = 'Inspect / recover'; inspect.addEventListener('click', () => inspectTask(task.id)); action.append(inspect);
        } else action.textContent = '—';
        tr.append(action); tb.append(tr);
      });
      const pb = $('participants-body'); pb.replaceChildren();
      if (!participants.length) empty(pb, 7, 'No matching participants.');
      participants.forEach(person => {
        const tr = document.createElement('tr'); cell(tr, person.displayName); cell(tr, person.kind);
        const status = cell(tr, ''); pill(status, person.status);
        cell(tr, (person.scopes || []).join(', ') || '-'); cell(tr, (person.capabilities || []).join(', ') || '-'); cell(tr, person.lastSeenAt);
        const action = document.createElement('td');
        const inspect = document.createElement('button'); inspect.type = 'button'; inspect.className = 'secondary compact';
        inspect.textContent = 'Inspect history'; inspect.addEventListener('click', () => inspectParticipant(person.id));
        action.append(inspect); tr.append(action); pb.append(tr);
      });
      const eb = $('events-body'); eb.replaceChildren();
      if (!events.length) empty(eb, 5, 'No matching events.');
      events.forEach(event => {
        const tr = document.createElement('tr'); cell(tr, event.occurredAt); cell(tr, event.eventType);
        cell(tr, event.entityType + ':' + event.entityId); cell(tr, event.actorParticipantId); cell(tr, event.sequence); eb.append(tr);
      });
      setText('auth-status', 'Connected · data refreshed ' + new Date().toLocaleTimeString());
    } catch (error) {
      if (!isCurrent() || error.name === 'AbortError') return;
      $('error').textContent = 'Could not load dashboard data: ' + error.message;
      if (error.message === 'authentication_required') disconnect('Authentication failed. Check the operator token.');
    } finally {
      if (isCurrent()) { activeRefresh = null; $('refresh').disabled = false; }
    }
  }
  function disconnect(message = 'Disconnected') {
    sessionEpoch++;
    activeRefresh?.abort();
    activeRefresh = null;
    operatorToken = '';
    $('operator-token').value = '';
    $('refresh').disabled = true;
    closeInspector();
    closeParticipantInspector();
    setText('auth-status', message);
    empty($('tasks-body'), 7, 'Connect to load tasks.');
    empty($('participants-body'), 7, 'Connect to load participants.');
    empty($('events-body'), 5, 'Connect to load events.');
    $('error').textContent = '';
    ['metric-active','metric-queued','metric-blocked','metric-participants','metric-unmatched'].forEach(id => setText(id, '—'));
  }
  $('auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const token = $('operator-token').value;
    if (token.length < 32 || token.length > 1024 || ![...token].every(character => /[A-Za-z0-9_-]/.test(character))) {
      disconnect('Token must contain between 32 and 1024 URL-safe ASCII characters (letters, digits, underscore, or hyphen).'); return;
    }
    sessionEpoch++; activeRefresh?.abort(); activeRefresh = null; closeInspector(); closeParticipantInspector();
    operatorToken = token; $('operator-token').value = ''; $('refresh').disabled = false;
    setText('auth-status', 'Connecting…'); await refresh();
  });
  $('disconnect').addEventListener('click', () => disconnect());
  $('refresh').addEventListener('click', refresh);
  $('close-inspector').addEventListener('click', closeInspector);
  $('close-participant-inspector').addEventListener('click', closeParticipantInspector);
  $('recovery-reason').addEventListener('input', updateRequeueButton);
  $('confirm-worker-stopped').addEventListener('change', updateRequeueButton);
  $('confirm-side-effects').addEventListener('change', updateRequeueButton);
  $('requeue-task').addEventListener('click', requeueTask);
  ['task-status','participant-status','participant-kind','event-entity'].forEach(id => $(id).addEventListener('change', refresh));
  ['task-type','event-id'].forEach(id => $(id).addEventListener('change', refresh));
  loadHealth();
  setInterval(loadHealth, 15000);
})();
