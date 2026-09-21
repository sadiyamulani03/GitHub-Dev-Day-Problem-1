'use strict';

/**
 * Front-end for the Practice-Day Outfit Caller.
 *
 * Deliberately thin: it collects input, calls the API and renders what the
 * server returns. It contains NO weather logic, NO recommendation wording and
 * NO authorisation decisions -- those live in the backend, which is the only
 * authority. The client-side checks below are a convenience for the coach; the
 * server re-validates everything and answers 4xx with an explanation when it
 * disagrees.
 */

const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

const state = {
  user: null,
  teams: [],
  selectedTeamId: null,
  authMode: 'login',
};

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------- API client

/** Thin fetch wrapper: cookies are sent automatically (same-origin session). */
async function api(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(path, options);
  const text = await response.text();
  let payload = null;
  if (text !== '') {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message =
      payload && payload.error && payload.error.message
        ? payload.error.message
        : `Request failed with status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.code = payload && payload.error ? payload.error.code : null;
    throw error;
  }

  return payload;
}

// ------------------------------------------------------------ small helpers

function showAlert(containerId, message, kind = 'error') {
  const container = el(containerId);
  container.innerHTML = '';
  if (!message) {
    return;
  }
  const div = document.createElement('div');
  div.className = `alert ${kind}`;
  div.textContent = message;
  container.appendChild(div);
}

function setBusy(button, busy, busyLabel) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyLabel;
    button.disabled = true;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
    button.disabled = false;
  }
}

function formatDayList(team) {
  const byValue = new Map(WEEKDAYS.map((day) => [day.value, day.label]));
  const labels = (team.practiceDays || []).map((value) => byValue.get(value) || String(value));
  return labels.length > 0 ? labels.join(', ') : 'no days set';
}

// ------------------------------------------------------------------- views

function renderSession() {
  const label = el('session-label');
  const logout = el('logout-button');

  if (state.user) {
    label.textContent = `${state.user.displayName} · ${state.user.email}`;
    logout.hidden = false;
    el('auth-view').hidden = true;
    el('dashboard-view').hidden = false;
  } else {
    label.textContent = '';
    logout.hidden = true;
    el('auth-view').hidden = false;
    el('dashboard-view').hidden = true;
  }
}

function renderAuthMode() {
  const registering = state.authMode === 'register';
  el('auth-title').textContent = registering ? 'Create a coach account' : 'Coach sign in';
  el('display-name-field').hidden = !registering;
  el('auth-submit').textContent = registering ? 'Create account' : 'Sign in';
  el('auth-toggle').textContent = registering ? 'I already have an account' : 'Create an account';
  el('auth-password').autocomplete = registering ? 'new-password' : 'current-password';
}

function renderTeamList() {
  const list = el('team-list');
  const stateBox = el('team-list-state');
  list.innerHTML = '';
  stateBox.innerHTML = '';

  if (state.teams.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No teams yet. Add your first team below.';
    stateBox.appendChild(empty);
    return;
  }

  for (const team of state.teams) {
    const item = document.createElement('li');
    item.setAttribute('aria-current', String(team.id === state.selectedTeamId));

    const left = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = team.name;
    const meta = document.createElement('div');
    meta.className = 'tiny';
    meta.textContent = `${team.location.resolvedName} · ${formatDayList(team)} at ${team.practiceTime} (${team.timezone})`;
    left.append(name, meta);

    const right = document.createElement('span');
    right.className = 'badge muted';
    right.textContent = `#${team.id}`;

    item.append(left, right);
    item.addEventListener('click', () => selectTeam(team.id));
    list.appendChild(item);
  }
}

function weatherTile(key, value) {
  const div = document.createElement('div');
  const k = document.createElement('div');
  k.className = 'k';
  k.textContent = key;
  const v = document.createElement('div');
  v.className = 'v';
  v.textContent = value;
  div.append(k, v);
  return div;
}

function renderTeamDetail(team, today, recommendation) {
  const wrapper = el('team-detail');
  wrapper.hidden = false;
  el('team-detail-state').hidden = true;
  wrapper.innerHTML = '';

  const heading = document.createElement('div');
  const title = document.createElement('h3');
  title.style.margin = '0 0 2px';
  title.textContent = team.name;
  const subtitle = document.createElement('div');
  subtitle.className = 'tiny';
  subtitle.textContent = `${team.location.resolvedName} · ${formatDayList(team)} at ${team.practiceTime} · ${team.timezone}`;
  heading.append(title, subtitle);

  const dl = document.createElement('dl');
  dl.className = 'dl';
  const pairs = [
    ['Practice date', today.practiceDate],
    ['Practice day today?', today.isPracticeDay ? 'Yes' : 'No — showing today anyway'],
    [
      'Location',
      `${team.location.resolvedName} (${team.location.latitude}, ${team.location.longitude})`,
    ],
  ];
  for (const [key, value] of pairs) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const generate = document.createElement('button');
  generate.type = 'button';
  generate.textContent = recommendation ? "Re-request today's call" : "Get today's call";
  generate.addEventListener('click', () => generateRecommendation(team.id, generate));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.textContent = 'Delete team';
  remove.addEventListener('click', () => deleteTeam(team.id));
  actions.append(generate, remove);

  wrapper.append(heading, dl, actions);

  if (recommendation) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `Stored ${recommendation.practiceDate} · id ${recommendation.id}`;

    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = recommendation.note;

    const weather = document.createElement('div');
    weather.className = 'weather';
    weather.append(
      weatherTile('Temperature', `${recommendation.temperatureC} °C`),
      weatherTile('Rain chance', `${recommendation.precipitationProbability} %`),
      weatherTile('Precip', `${recommendation.precipitationMm} mm`),
      weatherTile('Wind', `${recommendation.windSpeedKph} km/h`),
    );

    const source = document.createElement('div');
    source.className = 'tiny';
    source.textContent = `Forecast fetched server-side from ${recommendation.weatherProvider} at ${recommendation.weatherFetchedAt} — never supplied by this page.`;

    const reasoningTitle = document.createElement('div');
    reasoningTitle.className = 'tiny';
    reasoningTitle.style.marginTop = '12px';
    reasoningTitle.textContent = 'Why this call:';
    const reasoning = document.createElement('ul');
    reasoning.className = 'reasoning';
    for (const line of recommendation.reasoning || []) {
      const li = document.createElement('li');
      li.textContent = line;
      reasoning.appendChild(li);
    }

    const hint = document.createElement('p');
    hint.className = 'tiny';
    hint.textContent =
      'Re-requesting returns this same stored note for the same team and date — a second row is refused by a database unique constraint.';

    wrapper.append(badge, note, weather, source, reasoningTitle, reasoning, hint);
  } else {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.style.marginTop = '12px';
    empty.textContent =
      'No recommendation stored for today yet. Generate one to fetch the live forecast.';
    wrapper.appendChild(empty);
  }
}

// --------------------------------------------------------------- behaviours

async function loadSession() {
  try {
    const response = await api('GET', '/me');
    state.user = response.user;
  } catch (error) {
    if (error.status !== 401) {
      showAlert('global-alert', error.message);
    }
    state.user = null;
  }
  renderSession();
  if (state.user) {
    await loadTeams();
  }
}

async function loadTeams() {
  el('team-list-state').innerHTML = '<div class="spinner">Loading teams…</div>';
  try {
    const response = await api('GET', '/teams');
    state.teams = response.teams;
    if (state.selectedTeamId && !state.teams.some((team) => team.id === state.selectedTeamId)) {
      state.selectedTeamId = null;
    }
    renderTeamList();
    if (state.selectedTeamId) {
      await selectTeam(state.selectedTeamId);
    }
  } catch (error) {
    el('team-list-state').innerHTML = '';
    showAlert('global-alert', error.message);
  }
}

async function selectTeam(teamId) {
  state.selectedTeamId = teamId;
  renderTeamList();

  el('team-detail').hidden = true;
  el('team-detail-state').hidden = false;
  el('team-detail-state').innerHTML = '<div class="spinner">Loading team…</div>';

  try {
    const detail = await api('GET', `/teams/${teamId}`);
    state.teams = state.teams.map((team) => (team.id === detail.team.id ? detail.team : team));
    renderTeamList();

    let recommendation = null;
    if (detail.today.hasRecommendation) {
      // Reading the stored note; the server does not re-call the weather API.
      const stored = await api('GET', `/teams/${teamId}/recommendation`);
      recommendation = stored.recommendation;
    }

    renderTeamDetail(detail.team, detail.today, recommendation);
  } catch (error) {
    el('team-detail-state').innerHTML = '';
    el('team-detail-state').hidden = false;

    const box = document.createElement('div');
    box.className = 'alert error';
    box.textContent = error.message;
    if (error.code === 'TEAM_FORBIDDEN') {
      box.textContent = `${error.message} (403 — this team belongs to another coach)`;
    }
    if (error.code === 'TEAM_NOT_FOUND') {
      box.textContent = `${error.message} (404 — no such team)`;
    }
    el('team-detail-state').appendChild(box);
  }
}

async function generateRecommendation(teamId, button) {
  setBusy(button, true, 'Fetching forecast…');
  showAlert('global-alert', '');
  try {
    const response = await api('POST', `/teams/${teamId}/recommendation`, {});
    const detail = await api('GET', `/teams/${teamId}`);
    renderTeamDetail(detail.team, detail.today, response.recommendation);
    await loadTeams();
    showAlert(
      'global-alert',
      response.created
        ? 'New recommendation generated from a live forecast and stored.'
        : 'A recommendation for this team and date already existed — the stored one was returned unchanged.',
      response.created ? 'ok' : 'info',
    );
  } catch (error) {
    showAlert('global-alert', error.message);
  } finally {
    setBusy(button, false);
  }
}

async function deleteTeam(teamId) {
  const team = state.teams.find((candidate) => candidate.id === teamId);
  if (!window.confirm(`Delete ${team ? team.name : 'this team'} and its stored recommendations?`)) {
    return;
  }
  try {
    await api('DELETE', `/teams/${teamId}`);
    state.selectedTeamId = null;
    el('team-detail').hidden = true;
    el('team-detail-state').hidden = false;
    el('team-detail-state').innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Team deleted. Select another team or add a new one.';
    el('team-detail-state').appendChild(empty);
    showAlert('global-alert', 'Team deleted.', 'ok');
    await loadTeams();
  } catch (error) {
    showAlert('global-alert', error.message);
  }
}

// ------------------------------------------------------------------- wiring

function renderDayCheckboxes() {
  const container = el('practice-days');
  container.innerHTML = '';
  for (const day of WEEKDAYS) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(day.value);
    input.name = 'practiceDays';
    if (day.value === 1 || day.value === 3) {
      input.checked = true;
    }
    label.append(input, document.createTextNode(day.label));
    container.appendChild(label);
  }
}

function setupAuthForm() {
  el('auth-toggle').addEventListener('click', () => {
    state.authMode = state.authMode === 'login' ? 'register' : 'login';
    showAlert('auth-alert', '');
    renderAuthMode();
  });

  el('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showAlert('auth-alert', '');

    const email = el('auth-email').value.trim();
    const password = el('auth-password').value;
    const displayName = el('auth-display-name').value.trim();
    const button = el('auth-submit');
    const registering = state.authMode === 'register';

    // Convenience only -- the server validates these again and is authoritative.
    if (email === '' || password === '') {
      showAlert('auth-alert', 'Email and password are required.');
      return;
    }

    setBusy(button, true, registering ? 'Creating…' : 'Signing in…');
    try {
      const payload = registering ? { email, password, displayName } : { email, password };
      const response = await api('POST', registering ? '/auth/register' : '/auth/login', payload);
      state.user = response.user;
      renderSession();
      await loadTeams();
    } catch (error) {
      showAlert('auth-alert', error.message);
    } finally {
      setBusy(button, false);
    }
  });

  el('logout-button').addEventListener('click', async () => {
    try {
      await api('POST', '/auth/logout');
    } catch {
      /* the cookie is cleared client-side either way */
    }
    state.user = null;
    state.teams = [];
    state.selectedTeamId = null;
    showAlert('global-alert', '');
    renderSession();
  });
}

function setupCreateTeamForm() {
  el('create-team-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showAlert('create-alert', '');

    const name = el('team-name').value.trim();
    const location = el('team-location').value.trim();
    const latitude = el('team-lat').value.trim();
    const longitude = el('team-lon').value.trim();
    const practiceTime = el('team-time').value;
    const practiceDays = [...document.querySelectorAll('input[name="practiceDays"]:checked')].map(
      (input) => Number(input.value),
    );

    if (name === '') {
      showAlert('create-alert', 'A team name is required.');
      return;
    }
    if (location === '' && (latitude === '' || longitude === '')) {
      showAlert('create-alert', 'Provide a place name, or both a latitude and a longitude.');
      return;
    }
    if (practiceDays.length === 0) {
      showAlert('create-alert', 'Pick at least one practice day.');
      return;
    }

    const payload = { name, practiceDays, practiceTime };
    if (latitude !== '' && longitude !== '') {
      payload.latitude = Number(latitude);
      payload.longitude = Number(longitude);
    } else {
      payload.location = location;
    }

    const button = el('create-team-button');
    setBusy(button, true, 'Creating…');
    try {
      const response = await api('POST', '/teams', payload);
      state.selectedTeamId = response.team.id;
      el('team-name').value = '';
      el('team-location').value = '';
      el('team-lat').value = '';
      el('team-lon').value = '';
      showAlert(
        'create-alert',
        `Created ${response.team.name} at ${response.team.location.resolvedName}.`,
        'ok',
      );
      await loadTeams();
      await selectTeam(response.team.id);
    } catch (error) {
      showAlert('create-alert', error.message);
    } finally {
      setBusy(button, false);
    }
  });
}

async function boot() {
  renderDayCheckboxes();
  setupAuthForm();
  setupCreateTeamForm();
  renderAuthMode();
  renderSession();
  await loadSession();
}

document.addEventListener('DOMContentLoaded', boot);
