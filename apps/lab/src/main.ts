import './style.css';
import { Channel, Client, ExecutionMethod, Functions, Query, TablesDB } from 'appwrite';

const endpoint = 'https://fra.cloud.appwrite.io/v1';
const projectId = '6ae32d6f0034eb612a86';
const databaseId = 'doubletap';
const taps = 100;

type Via = 'naive' | 'doubletap';
interface TraceRow { requestId: string; phase: string; at: number }

const client = new Client().setEndpoint(endpoint).setProject(projectId);
const functions = new Functions(client);
const tablesDB = new TablesDB(client);

const button = document.querySelector<HTMLButtonElement>('#run')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const sides = {
  naive: document.querySelector<HTMLElement>('.side[data-via="naive"]')!,
  doubletap: document.querySelector<HTMLElement>('.side[data-via="doubletap"]')!,
};
const functionIds: Record<Via, string> = { naive: 'pay-naive', doubletap: 'pay-doubletap' };

const randomId = (prefix: string) =>
  `${prefix}_${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

function setText(via: Via, selector: string, value: string | number) {
  sides[via].querySelector(selector)!.textContent = String(value);
}

function setCharges(via: Via, n: number) {
  setText(via, '.charges', n);
  setText(via, '.unit', n === 1 ? 'charge' : 'charges');
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

async function countCharges(orderId: string): Promise<number> {
  const page = await tablesDB.listRows({
    databaseId,
    tableId: 'charges',
    queries: [Query.equal('orderId', orderId), Query.limit(1)],
  });
  return page.total;
}

async function countEnds(run: string): Promise<number> {
  const page = await tablesDB.listRows({
    databaseId,
    tableId: 'trace',
    queries: [Query.equal('run', run), Query.equal('phase', 'end'), Query.limit(1)],
  });
  return page.total;
}

const svgNs = 'http://www.w3.org/2000/svg';
function el(name: string, attrs: Record<string, string | number>) {
  const node = document.createElementNS(svgNs, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function drawTimeline(via: Via, rows: TraceRow[], t0: number, t1: number) {
  const box = sides[via].querySelector<HTMLDivElement>('.timeline')!;
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
    const charged = events.some((e) => e.phase === 'charge');
    const start = events[0].at;
    const end = events[events.length - 1].at;
    svg.append(el('line', {
      x1: x(start), x2: Math.max(x(end), x(start) + 1), y1: y, y2: y,
      stroke: charged ? '#1a1a1a' : '#d0d0d0', 'stroke-width': charged ? 1.6 : 1,
    }));
    for (const e of events) {
      if (e.phase === 'read-empty') {
        svg.append(el('circle', { cx: x(e.at), cy: y, r: 1.8, fill: '#fff', stroke: '#1a1a1a', 'stroke-width': 0.9 }));
      } else if (e.phase === 'charge') {
        svg.append(el('circle', { cx: x(e.at), cy: y, r: 2.4, fill: '#b42318' }));
      } else if (e.phase === 'replay') {
        svg.append(el('circle', { cx: x(e.at), cy: y, r: 1.5, fill: '#9aa0a6' }));
      }
    }
  });
  const axisY = top + ordered.length * laneH + 6;
  svg.append(el('line', { x1: left, x2: width - right, y1: axisY, y2: axisY, stroke: '#bbb', 'stroke-width': 0.8 }));
  const label = (text: string, xPos: number, anchor: string) => {
    const t = el('text', { x: xPos, y: axisY + 12, 'font-size': 9, fill: '#666', 'text-anchor': anchor });
    t.textContent = text;
    svg.append(t);
  };
  label('0 s', left, 'start');
  label(`${(span / 1000).toFixed(1)} s`, width - right, 'end');
  box.append(svg);
}

async function run() {
  button.disabled = true;
  const runs: Record<Via, string> = { naive: randomId('r'), doubletap: randomId('r') };
  const counts: Record<Via, number> = { naive: 0, doubletap: 0 };
  const done: Record<Via, number> = { naive: 0, doubletap: 0 };
  for (const via of ['naive', 'doubletap'] as Via[]) {
    setCharges(via, 0);
    setText(via, '.done', 0);
    setText(via, '.total', taps);
    sides[via].classList.remove('bad');
    sides[via].querySelector('.timeline')!.replaceChildren();
  }
  status.textContent = `Sending ${taps} taps to each function...`;

  const unsubscribe = client.subscribe(
    [
      Channel.tablesdb(databaseId).table('charges').row().create(),
      Channel.tablesdb(databaseId).table('trace').row().create(),
    ],
    (event) => {
      const row = event.payload as { orderId?: string; run?: string; phase?: string };
      for (const via of ['naive', 'doubletap'] as Via[]) {
        if (row.orderId === runs[via]) {
          counts[via] += 1;
          setCharges(via, counts[via]);
          sides[via].classList.toggle('bad', counts[via] > 1);
        }
        if (row.run === runs[via] && row.phase === 'end') {
          done[via] = Math.min(taps, done[via] + 1);
          setText(via, '.done', done[via]);
        }
      }
    },
  );

  const fire = (via: Via) =>
    functions
      .createExecution({
        functionId: functionIds[via],
        body: JSON.stringify({ orderId: runs[via], run: runs[via], requestId: randomId('q') }),
        async: true,
        method: ExecutionMethod.POST,
      });

  const calls: Promise<unknown>[] = [];
  for (let i = 0; i < taps; i += 1) calls.push(fire('naive'), fire('doubletap'));
  const results = await Promise.allSettled(calls);
  const failed = results.filter((r) => r.status === 'rejected').length;
  status.textContent = `All taps sent. Waiting for the functions to answer...`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const [n, d] = await Promise.all([countEnds(runs.naive), countEnds(runs.doubletap)]);
    done.naive = Math.min(taps, Math.max(done.naive, n));
    done.doubletap = Math.min(taps, Math.max(done.doubletap, d));
    setText('naive', '.done', done.naive);
    setText('doubletap', '.done', done.doubletap);
    if (n + d >= taps * 2 - failed) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  unsubscribe();

  status.textContent = 'All taps answered. Loading the replay...';
  const [naiveCount, dtCount, naiveTrace, dtTrace] = await Promise.all([
    countCharges(runs.naive),
    countCharges(runs.doubletap),
    listAll<TraceRow>('trace', 'run', runs.naive),
    listAll<TraceRow>('trace', 'run', runs.doubletap),
  ]);
  setCharges('naive', naiveCount);
  setCharges('doubletap', dtCount);
  sides.naive.classList.toggle('bad', naiveCount > 1);
  sides.doubletap.classList.toggle('bad', dtCount > 1);

  const all = [...naiveTrace, ...dtTrace].map((r) => r.at);
  const t0 = Math.min(...all);
  const t1 = Math.max(...all);
  drawTimeline('naive', naiveTrace, t0, t1);
  drawTimeline('doubletap', dtTrace, t0, t1);

  status.textContent =
    `One order, ${taps} taps each. Without doubletap: ${naiveCount} ${naiveCount === 1 ? 'charge' : 'charges'}. With doubletap: ${dtCount}.` +
    (failed ? ` ${failed} requests failed to answer.` : '');
  button.disabled = false;
}

button.addEventListener('click', () => {
  run().catch((error: unknown) => {
    status.textContent = `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;
    button.disabled = false;
  });
});
