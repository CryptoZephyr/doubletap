import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource-variable/newsreader/opsz.css';
import './style.css';
import { Channel, Client, ExecutionMethod, Functions, Query, TablesDB } from 'appwrite';

const endpoint = 'https://fra.cloud.appwrite.io/v1';
const projectId = '6ae32d6f0034eb612a86';
const databaseId = 'doubletap';
const taps = 100;
const cooldownMs = 60_000;
const cooldownKey = 'doubletap-lab-last-run';

type Via = 'naive' | 'doubletap';
type RaceId = 'pay' | 'job';
interface TraceRow { requestId: string; phase: string; at: number }
interface RaceConfig {
  mode: RaceId;
  hitPhase: string;
  missPhases: string[];
  verdict: (n: number) => [string, string];
  summary: (naive: number, dt: number) => string;
  count: (run: string) => Promise<number>;
  isHit: (row: { orderId?: string; run?: string; phase?: string }, run: string) => boolean;
}

const client = new Client().setEndpoint(endpoint).setProject(projectId);
const functions = new Functions(client);
const tablesDB = new TablesDB(client);
const functionIds: Record<Via, string> = { naive: 'pay-naive', doubletap: 'pay-doubletap' };
const vias: Via[] = ['naive', 'doubletap'];
const cooldown = document.querySelector<HTMLParagraphElement>('#cooldown')!;
const cooldownBox = document.querySelector<HTMLDivElement>('#cooldown-box')!;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function total(tableId: string, queries: string[]): Promise<number> {
  const page = await tablesDB.listRows({ databaseId, tableId, queries: [...queries, Query.limit(1)] });
  return page.total;
}

const races: Record<RaceId, RaceConfig> = {
  pay: {
    mode: 'pay',
    hitPhase: 'charge',
    missPhases: ['replay'],
    verdict: (n) => n === 1 ? ['Charged once', '1 charge'] : ['Charged more than once', `${n} charges`],
    summary: (n, d) =>
      `One order, ${taps} taps each. Without doubletap: ${plural(n, 'charge', 'charges')}. With doubletap: ${plural(d, 'charge', 'charges')}.`,
    count: (run) => total('charges', [Query.equal('orderId', run)]),
    isHit: (row, run) => row.orderId === run,
  },
  job: {
    mode: 'job',
    hitPhase: 'won',
    missPhases: ['refused'],
    verdict: (n) => n === 1 ? ['One owner', '1 worker'] : ['Same job, several owners', `${n} workers`],
    summary: (n, d) =>
      `One job, ${taps} workers each. With a transaction: ${plural(n, 'owner', 'owners')}. With doubletap: ${plural(d, 'owner', 'owners')}.`,
    count: (run) => total('trace', [Query.equal('run', run), Query.equal('phase', 'won')]),
    isHit: (row, run) => row.run === run && row.phase === 'won',
  },
};

const randomId = (prefix: string) =>
  `${prefix}_${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

function section(race: RaceId) {
  return document.querySelector<HTMLElement>(`.race[data-race="${race}"]`)!;
}
function side(race: RaceId, via: Via) {
  return section(race).querySelector<HTMLElement>(`.side[data-via="${via}"]`)!;
}
function setText(race: RaceId, via: Via, selector: string, value: string | number) {
  side(race, via).querySelector(selector)!.textContent = String(value);
}
function setCount(race: RaceId, via: Via, n: number) {
  setText(race, via, '.count', n);
  side(race, via).classList.toggle('bad', n > 1);
}
function setStamp(race: RaceId, via: Via, n: number | null) {
  const stamp = side(race, via).querySelector<HTMLElement>('.stamp')!;
  stamp.hidden = n === null || n === 0;
  stamp.removeAttribute('data-land');
  if (stamp.hidden || n === null) return;
  const [word, figure] = races[race].verdict(n);
  stamp.dataset.kind = n === 1 ? 'once' : 'many';
  stamp.querySelector('.stamp-word')!.textContent = word;
  stamp.querySelector('.stamp-figure')!.textContent = figure;
  void stamp.offsetWidth;
  stamp.setAttribute('data-land', '');
}

async function listAll<T>(tableId: string, field: string, value: string): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;
  while (true) {
    const queries = [Query.equal(field, value), Query.orderAsc('$id'), Query.limit(500)];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const page = await tablesDB.listRows({ databaseId, tableId, queries });
    rows.push(...(page.rows as unknown as T[]));
    if (page.rows.length < 500) return rows;
    cursor = page.rows[page.rows.length - 1].$id;
  }
}

const svgNs = 'http://www.w3.org/2000/svg';
function el(name: string, attrs: Record<string, string | number>) {
  const node = document.createElementNS(svgNs, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function drawTimeline(race: RaceId, via: Via, rows: TraceRow[], t0: number, t1: number) {
  const { hitPhase, missPhases } = races[race];
  const box = side(race, via).querySelector<HTMLDivElement>('.timeline')!;
  box.replaceChildren();
  const lanes = new Map<string, TraceRow[]>();
  for (const row of rows) {
    if (!lanes.has(row.requestId)) lanes.set(row.requestId, []);
    lanes.get(row.requestId)!.push(row);
  }
  if (lanes.size === 0) {
    box.innerHTML = '<p class="empty">No trace rows came back for this run.</p>';
    return;
  }
  const ordered = [...lanes.values()]
    .map((events) => events.sort((a, b) => a.at - b.at))
    .sort((a, b) => a[0].at - b[0].at);

  const width = 520;
  const left = 8;
  const right = 8;
  const top = 8;
  const laneH = 4;
  const axisH = 22;
  const height = top + ordered.length * laneH + axisH;
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => left + ((t - t0) / span) * (width - left - right);

  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
  svg.setAttribute('aria-label', `Replay of ${ordered.length} requests`);
  ordered.forEach((events, index) => {
    const y = top + index * laneH + laneH / 2;
    const hit = events.some((e) => e.phase === hitPhase);
    const start = events[0].at;
    const end = events[events.length - 1].at;
    svg.append(el('line', {
      x1: x(start), x2: Math.max(x(end), x(start) + 1), y1: y, y2: y,
      stroke: hit ? '#1F2421' : '#DAD2C3', 'stroke-width': hit ? 1.6 : 1,
    }));
    for (const e of events) {
      if (e.phase === 'read-empty') {
        svg.append(el('circle', { cx: x(e.at), cy: y, r: 1.8, fill: '#FFFFFF', stroke: '#1F2421', 'stroke-width': 0.9 }));
      } else if (e.phase === hitPhase) {
        svg.append(el('circle', { cx: x(e.at), cy: y, r: 2.4, fill: '#B3402F' }));
      } else if (missPhases.includes(e.phase)) {
        svg.append(el('circle', { cx: x(e.at), cy: y, r: 1.5, fill: '#7A7F78' }));
      }
    }
  });
  const axisY = top + ordered.length * laneH + 6;
  svg.append(el('line', { x1: left, x2: width - right, y1: axisY, y2: axisY, stroke: '#DAD2C3', 'stroke-width': 0.8 }));
  const label = (text: string, xPos: number, anchor: string) => {
    const t = el('text', { x: xPos, y: axisY + 12, 'font-size': 9, fill: '#5C625D', 'font-family': 'IBM Plex Mono, monospace', 'text-anchor': anchor });
    t.textContent = text;
    svg.append(t);
  };
  label('0 s', left, 'start');
  label(`${(span / 1000).toFixed(1)} s`, width - right, 'end');
  box.append(svg);
}

let running = false;
const buttons = [...document.querySelectorAll<HTMLButtonElement>('.race .run')];

function lastRun(): number {
  return Number(localStorage.getItem(cooldownKey) ?? 0);
}
function refreshButtons() {
  const wait = lastRun() + cooldownMs - Date.now();
  for (const b of buttons) b.disabled = running || wait > 0;
  cooldown.textContent = !running && wait > 0
    ? `To keep this free demo within Appwrite's Free plan, the next race can start in ${Math.ceil(wait / 1000)} s.`
    : '';
  cooldownBox.hidden = cooldown.textContent === '';
}
setInterval(refreshButtons, 1000);
refreshButtons();

async function run(race: RaceId) {
  const config = races[race];
  const status = section(race).querySelector<HTMLParagraphElement>('.status')!;
  running = true;
  localStorage.setItem(cooldownKey, String(Date.now()));
  refreshButtons();

  const runs: Record<Via, string> = { naive: randomId('r'), doubletap: randomId('r') };
  const counts: Record<Via, number> = { naive: 0, doubletap: 0 };
  const done: Record<Via, number> = { naive: 0, doubletap: 0 };
  for (const via of vias) {
    setCount(race, via, 0);
    setText(race, via, '.done', 0);
    setText(race, via, '.total', taps);
    setStamp(race, via, null);
    side(race, via).querySelector('.timeline')!.replaceChildren();
  }
  status.textContent = `Sending ${taps} requests to each function...`;

  const unsubscribe = client.subscribe(
    [
      Channel.tablesdb(databaseId).table('charges').row().create(),
      Channel.tablesdb(databaseId).table('trace').row().create(),
    ],
    (event) => {
      const row = event.payload as { orderId?: string; run?: string; phase?: string };
      for (const via of vias) {
        if (config.isHit(row, runs[via])) {
          counts[via] += 1;
          setCount(race, via, counts[via]);
        }
        if (row.run === runs[via] && row.phase === 'end') {
          done[via] = Math.min(taps, done[via] + 1);
          setText(race, via, '.done', done[via]);
        }
      }
    },
  );

  try {
    const fire = (via: Via) =>
      functions.createExecution({
        functionId: functionIds[via],
        body: JSON.stringify({ orderId: runs[via], run: runs[via], requestId: randomId('q'), mode: config.mode }),
        async: true,
        method: ExecutionMethod.POST,
      });

    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < taps; i += 1) calls.push(fire('naive'), fire('doubletap'));
    const results = await Promise.allSettled(calls);
    const failed = results.filter((r) => r.status === 'rejected').length;
    status.textContent = 'All requests sent. Waiting for the functions to answer...';
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const [n, d] = await Promise.all(vias.map((via) =>
        total('trace', [Query.equal('run', runs[via]), Query.equal('phase', 'end')])));
      done.naive = Math.min(taps, Math.max(done.naive, n));
      done.doubletap = Math.min(taps, Math.max(done.doubletap, d));
      for (const via of vias) setText(race, via, '.done', done[via]);
      if (n + d >= taps * 2 - failed) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    status.textContent = 'All requests answered. Loading the replay...';
    const [naiveCount, dtCount, naiveTrace, dtTrace] = await Promise.all([
      config.count(runs.naive),
      config.count(runs.doubletap),
      listAll<TraceRow>('trace', 'run', runs.naive),
      listAll<TraceRow>('trace', 'run', runs.doubletap),
    ]);
    setCount(race, 'naive', naiveCount);
    setCount(race, 'doubletap', dtCount);
    setStamp(race, 'naive', naiveCount);
    setStamp(race, 'doubletap', dtCount);

    const all = [...naiveTrace, ...dtTrace].map((r) => r.at);
    if (all.length) {
      const t0 = Math.min(...all);
      const t1 = Math.max(...all);
      drawTimeline(race, 'naive', naiveTrace, t0, t1);
      drawTimeline(race, 'doubletap', dtTrace, t0, t1);
    }
    const unanswered = taps * 2 - done.naive - done.doubletap;
    status.textContent = config.summary(naiveCount, dtCount) +
      (failed ? ` ${failed} requests couldn't be sent.` : '') +
      (unanswered > failed ? ` ${unanswered - failed} requests didn't answer within a minute.` : '');
  } finally {
    unsubscribe();
    running = false;
    refreshButtons();
  }
}

for (const race of Object.keys(races) as RaceId[]) {
  const button = section(race).querySelector<HTMLButtonElement>('.run')!;
  button.addEventListener('click', () => {
    run(race).catch((error: unknown) => {
      section(race).querySelector('.status')!.textContent =
        `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;
    });
  });
}
