/*
 * Landing motion layer.
 *
 * Lifted from the approved references in site/samples/ and adapted to the Astro components:
 *   [grid]     Hero horizon perspective grid ...... v3-2-vector [E1]      -> HeroGrid.astro
 *   [crt]      Hero CRT glass (power-on, sweep) ... v3-lab 12 / v3-1-phosphor -> CrtGlass.astro
 *   [decode]   Glyph decode, hero H1 + final CTA .. v3-lab 1 / v3-1-phosphor text-decode -> [data-decode]
 *   [words]    Section H2 word mask-up ............ v3-2-vector [E3] -> [data-words]
 *   [stagger]  Section content + mock items ....... v3-2-vector [E2] / v3-3-teletype [TT-12] (CSS, --i set here)
 *   [trace]    Self-drawing borders + hover orbit . v3-2-vector [E5][E6] -> .stage, .frame, .os-card, .license
 *   [rail]     Circuit rail with packets .......... v3-2-vector [E7] -> svg.rail in <main>
 *   [marquee]  Command marquee .................... v3-lab 16 / v3-2-vector [E8] -> CommandMarquee.astro
 *   [readout]  Braille spinner + meters ........... v3-lab 15 / v3-3-teletype [TT-11] -> CliReadout.astro
 *   [dither]   Ordered dither band ................ v3-lab 13 -> DitherBand.astro
 *
 * State lives on <html>: .m-on, or .m-off under prefers-reduced-motion (static, fully drawn), set before
 * first paint by the inline gate in index.astro.
 * Canvas and text work share one requestAnimationFrame loop; each task pauses via IntersectionObserver
 * when its element is offscreen, and the loop stops entirely when motion is off.
 */

type Task = { active: boolean; draw: (t: number) => void; still?: () => void };

const root = document.documentElement;
const hasIO = 'IntersectionObserver' in window;
const DPR = Math.min(window.devicePixelRatio || 1, 2);

const isOn = () => root.classList.contains('m-on');

/* ---------------- shared rAF loop ---------------- */
const tasks: Task[] = [];
let raf = 0;
const t0 = performance.now();

function frame(now: number) {
	raf = 0;
	if (!isOn()) return;
	const t = (now - t0) / 1000;
	let any = false;
	for (const k of tasks) {
		if (k.active) {
			k.draw(t);
			any = true;
		}
	}
	if (any) raf = requestAnimationFrame(frame);
}
function kick() {
	if (!raf && isOn()) raf = requestAnimationFrame(frame);
}
function addTask(el: Element | null, draw: Task['draw'], still?: Task['still'], margin = '60px'): Task {
	const k: Task = { active: !hasIO || !el, draw, still };
	tasks.push(k);
	if (el && hasIO) {
		new IntersectionObserver(
			(entries) => {
				for (const e of entries) k.active = e.isIntersecting;
				kick();
			},
			{ rootMargin: margin },
		).observe(el);
	}
	return k;
}
/** Toggle a class on an element while it is on screen (for CSS-driven loops). */
function visClass(el: Element, cls: string, margin = '40px') {
	if (!hasIO) {
		el.classList.add(cls);
		return;
	}
	new IntersectionObserver(
		(entries) => {
			for (const e of entries) el.classList.toggle(cls, e.isIntersecting);
		},
		{ rootMargin: margin },
	).observe(el);
}

/* ---------------- [decode] glyph decode ---------------- */
const GLYPHS = '░▒▓<>/\\|_-=+*#%ABCDEFGHJKLMNPRSTUVXYZ0123456789';
const glyph = () => GLYPHS.charAt((Math.random() * GLYPHS.length) | 0);

type DecodeEl = HTMLElement & { _chars?: HTMLSpanElement[] };
type Job = { el: DecodeEl; chars: HTMLSpanElement[]; t0: number; d: number; s: number[]; e: number[]; g: number[]; st: number[] };

// Split once: the real text moves into a .visually-hidden copy; the animated copy is aria-hidden.
// Every character keeps its real glyph (visibility:hidden while scrambling), so widths are reserved.
function split(el: DecodeEl): HTMLSpanElement[] {
	if (el._chars) return el._chars;
	const sr = document.createElement('span');
	sr.className = 'visually-hidden';
	sr.textContent = (el.textContent || '').replace(/\s+/g, ' ').trim();
	const vis = document.createElement('span');
	vis.setAttribute('aria-hidden', 'true');
	while (el.firstChild) vis.appendChild(el.firstChild);
	const chars: HTMLSpanElement[] = [];
	(function walk(node: Node) {
		Array.from(node.childNodes).forEach((n) => {
			if (n.nodeType === 3) {
				const frag = document.createDocumentFragment();
				(n.nodeValue || '').split(/(\s+)/).forEach((tok) => {
					if (!tok) return;
					if (/^\s+$/.test(tok)) {
						frag.appendChild(document.createTextNode(' '));
						return;
					}
					const w = document.createElement('span');
					w.className = 'dc-w';
					for (const chr of Array.from(tok)) {
						const c = document.createElement('span');
						c.className = 'dc-ch';
						c.textContent = chr;
						w.appendChild(c);
						chars.push(c);
					}
					frag.appendChild(w);
				});
				node.replaceChild(frag, n);
			} else if (n.nodeType === 1) walk(n);
		});
	})(vis);
	el.appendChild(sr);
	el.appendChild(vis);
	el.setAttribute('data-scr', '');
	return (el._chars = chars);
}

let jobs: Job[] = [];
let hot: [HTMLSpanElement, number][] = [];
let firstArm = true;
let decodeIO: IntersectionObserver | null = null;
const decodeTargets = Array.from(document.querySelectorAll<DecodeEl>('[data-decode]'));

function startDecode(el: DecodeEl, delay: number) {
	const chars = split(el);
	const n = chars.length;
	const stagger = Math.max(14, Math.min(32, 760 / n));
	const job: Job = { el, chars, t0: 0, d: delay, s: [], e: [], g: [], st: [] };
	chars.forEach((c, i) => {
		c.className = 'dc-ch pre';
		job.s[i] = i * stagger;
		job.e[i] = i * stagger + 170 + Math.random() * 280;
		job.g[i] = 0;
		job.st[i] = 0;
	});
	jobs.push(job);
	decodeTask.active = true;
	kick();
}
function tickDecode() {
	const now = performance.now();
	jobs = jobs.filter((j) => {
		if (!j.t0) j.t0 = now + j.d; // set on the first frame so a busy main thread can't skip the effect
		const e = now - j.t0;
		let left = 0;
		if (e < 0) return true;
		for (let i = 0; i < j.chars.length; i++) {
			const c = j.chars[i];
			if (j.st[i] === 2) continue;
			if (e >= j.e[i]) {
				c.className = 'dc-ch hot';
				j.st[i] = 2;
				hot.push([c, now]);
			} else if (e >= j.s[i]) {
				if (j.st[i] !== 1) {
					c.className = 'dc-ch sc';
					j.st[i] = 1;
				}
				if (now - j.g[i] > 65) {
					c.setAttribute('data-g', glyph());
					j.g[i] = now;
				}
				left++;
			} else left++;
		}
		return left > 0;
	});
	hot = hot.filter((h) => {
		if (now - h[1] > 110) {
			h[0].className = 'dc-ch';
			return false;
		}
		return true;
	});
	decodeTask.active = jobs.length > 0 || hot.length > 0;
}
function finishDecode() {
	jobs = [];
	hot = [];
	decodeTask.active = false;
	for (const el of decodeTargets) for (const c of el._chars || []) c.className = 'dc-ch';
}
function armDecode() {
	for (const el of decodeTargets) for (const c of split(el)) c.className = 'dc-ch pre';
	if (!hasIO) {
		decodeTargets.forEach((el) => startDecode(el, 0));
		return;
	}
	decodeIO = new IntersectionObserver(
		(entries) => {
			for (const en of entries) {
				if (!en.isIntersecting) continue;
				const el = en.target as DecodeEl;
				const d = firstArm && el.dataset.decodeDelay ? +el.dataset.decodeDelay : 160;
				startDecode(el, d);
				decodeIO?.unobserve(el);
			}
			firstArm = false;
		},
		{ rootMargin: '0px 0px -8% 0px', threshold: 0.15 },
	);
	decodeTargets.forEach((el) => decodeIO!.observe(el));
}
function disarmDecode() {
	decodeIO?.disconnect();
	decodeIO = null;
	finishDecode();
}
const decodeTask: Task = { active: false, draw: tickDecode };
tasks.push(decodeTask);
decodeTargets.forEach(split);

/* ---------------- [grid] hero horizon perspective grid ---------------- */
const hero = document.querySelector<HTMLElement>('.hero');
const heroCanvas = document.querySelector<HTMLCanvasElement>('.hero-grid');
const heroH1 = document.querySelector<HTMLElement>('.hero h1');
const hx = heroCanvas?.getContext('2d') ?? null;
let HW = 0;
let HH = 0;
let HZ = 0;

function sizeHero() {
	if (!hero || !heroCanvas || !heroH1) return;
	// Layout offsets, not getBoundingClientRect: the power-on animation scales the hero content.
	const topIn = (el: HTMLElement) => {
		let y = 0;
		for (let n: HTMLElement | null = el; n && n !== hero; n = n.offsetParent as HTMLElement | null) y += n.offsetTop;
		return y;
	};
	const stage = hero.querySelector<HTMLElement>('.stage');
	HW = hero.clientWidth;
	HZ = topIn(heroH1) + heroH1.offsetHeight + 8;
	const stageTop = stage ? topIn(stage) : hero.clientHeight;
	HH = Math.max(HZ + 40, Math.min(hero.clientHeight, stageTop + 260));
	heroCanvas.style.height = HH + 'px';
	heroCanvas.width = Math.round(HW * DPR);
	heroCanvas.height = Math.round(HH * DPR);
}
function drawGrid(t: number) {
	const g = hx;
	if (!g || !HW) return;
	g.setTransform(DPR, 0, 0, DPR, 0, 0);
	g.globalCompositeOperation = 'source-over';
	g.clearRect(0, 0, HW, HH);
	const cx = HW / 2;
	const f = HH - HZ;
	const s = HW < 700 ? 0.34 : 0.24;
	const sz = 0.42;
	const zN = 1;
	const zF = 28;
	const v = 0.3;
	g.lineWidth = 1;
	// longitudinal rails; two orange highlight rails
	const K = Math.ceil((HW * 0.95) / (s * f));
	const hotK = HW < 700 ? 2 : 5;
	for (let k = -K; k <= K; k++) {
		const x = k * s;
		const isHot = k === hotK || k === -hotK;
		g.strokeStyle = isHot ? 'rgba(255,138,61,.34)' : 'rgba(140,160,205,.16)';
		g.beginPath();
		g.moveTo(cx + (x * f) / zN, HZ + f / zN);
		g.lineTo(cx + (x * f) / zF, HZ + f / zF);
		g.stroke();
	}
	// crossbars scrolling toward the viewer; every 9th one orange
	const travel = t * v;
	const off = travel % sz;
	const base = Math.floor(travel / sz);
	for (let i = 0; i < 80; i++) {
		const z = zN + i * sz - off;
		if (z < zN) continue;
		if (z > zF) break;
		const y = HZ + f / z;
		const a = Math.min(1, 2.4 / z);
		const hotL = (i + base) % 9 === 0;
		g.strokeStyle = hotL ? `rgba(255,138,61,${(0.5 * a).toFixed(3)})` : `rgba(140,160,205,${(0.2 * a).toFixed(3)})`;
		g.beginPath();
		g.moveTo(0, y);
		g.lineTo(HW, y);
		g.stroke();
	}
	// fog: erase toward the horizon
	g.globalCompositeOperation = 'destination-out';
	const fog = g.createLinearGradient(0, HZ, 0, HZ + f * 0.42);
	fog.addColorStop(0, 'rgba(0,0,0,1)');
	fog.addColorStop(1, 'rgba(0,0,0,0)');
	g.fillStyle = fog;
	g.fillRect(0, HZ - 2, HW, f * 0.42 + 2);
	// horizon hairline + glow
	g.globalCompositeOperation = 'source-over';
	const hz = g.createLinearGradient(0, 0, HW, 0);
	hz.addColorStop(0, 'rgba(255,138,61,0)');
	hz.addColorStop(0.5, 'rgba(255,138,61,.55)');
	hz.addColorStop(1, 'rgba(255,138,61,0)');
	g.fillStyle = hz;
	g.fillRect(0, HZ, HW, 1);
	g.globalAlpha = 0.18;
	g.fillRect(0, HZ - 3, HW, 7);
	g.globalAlpha = 1;
}
const gridStill = () => drawGrid(0);
if (hero && hx) addTask(hero, drawGrid, gridStill);

/* ---------------- [crt] power-on + rolling bar ---------------- */
const crt = document.querySelector<HTMLElement>('.crt');
function syncCrt() {
	if (crt) crt.style.setProperty('--hh', crt.offsetHeight + 'px');
}
function replayBoot() {
	if (!hero) return;
	hero.classList.remove('boot');
	void hero.offsetWidth;
	hero.classList.add('boot');
}
if (crt) visClass(crt, 'vis');

/* ---------------- [marquee] pause offscreen ---------------- */
const marquee = document.querySelector('.marquee');
if (marquee) visClass(marquee, 'run', '0px');

/* ---------------- [readout] braille spinner + meters ---------------- */
(function () {
	const ro = document.querySelector('.readout');
	if (!ro) return;
	const spin = ro.querySelector('.spin');
	const status = ro.querySelector('.ro-s');
	const spark = ro.querySelector('.spark');
	const fill = ro.querySelector('.meter .f');
	const empty = ro.querySelector('.meter .e2');
	const num = ro.querySelector('.ro-n');
	if (!spin || !spark || !fill || !empty) return;
	const F = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
	const B = '▁▂▃▄▅▆▇█';
	const STATUS = ['watching acme.atlas', 'resolving globex.ledger', 'briefing acme.atlas'];
	const initial = spark.textContent || '';
	const vals: number[] = [];
	for (let j = 0; j < 16; j++) {
		const ix = B.indexOf(initial.charAt(j));
		vals.push(ix < 0 ? 2 : ix);
	}
	let fi = 0;
	let v = 3;
	let m = 11;
	let si = 0;
	let ts = -1;
	let tk = -1;
	let tm = -1;
	let tst = -1;
	addTask(ro, (t) => {
		const ms = t * 1000;
		if (ms - ts > 85) {
			ts = ms;
			spin.textContent = F[(fi = (fi + 1) % F.length)];
		}
		if (ms - tk > 240) {
			tk = ms;
			v = Math.max(0, Math.min(7, v + Math.round((Math.random() - 0.5) * 3 + (3.5 - v) * 0.25)));
			vals.push(v);
			vals.shift();
			spark.textContent = vals.map((x) => B[x]).join('');
		}
		if (ms - tm > 900) {
			tm = ms;
			m = Math.max(8, Math.min(13, m + (Math.random() < 0.5 ? -1 : 1)));
			fill.textContent = '█'.repeat(m);
			empty.textContent = '░'.repeat(14 - m);
			if (num) num.textContent = (2.2 + m * 0.08).toFixed(1) + ' KB';
		}
		if (status && ms - tst > 3600) {
			if (tst >= 0) status.textContent = STATUS[(si = (si + 1) % STATUS.length)];
			tst = ms;
		}
	});
})();

/* ---------------- [dither] ordered dither band ---------------- */
let ditherStill: (() => void) | null = null;
(function () {
	const cv = document.querySelector<HTMLCanvasElement>('canvas.dither-band');
	const ctx = cv?.getContext('2d');
	if (!cv || !ctx) return;
	const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((x) => (x + 0.5) / 16);
	const SCALE = 3; // rendered at 1/3 resolution, scaled up with image-rendering: pixelated
	let img: ImageData | null = null;
	let step = -1;
	function fit() {
		const r = cv!.getBoundingClientRect();
		const w = Math.max(1, Math.round(r.width / SCALE));
		const h = Math.max(1, Math.round(r.height / SCALE));
		if (cv!.width !== w || cv!.height !== h || !img) {
			cv!.width = w;
			cv!.height = h;
			img = ctx!.createImageData(w, h);
		}
	}
	function draw(t: number) {
		fit();
		const w = cv!.width;
		const h = cv!.height;
		const d = img!.data;
		const c = ((t * 0.11) % 1.7) - 0.35;
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const th = BAYER[(y & 3) * 4 + (x & 3)];
				const u = x / w;
				const vv = y / h;
				const dd = u + vv * 0.35 - c;
				const o = Math.exp((-dd * dd) / 0.028) * 0.95;
				const tq = 0.22 + 0.18 * Math.sin(u * 9 - t * 0.7 + vv * 4) * (1 - vv * 0.4);
				const i = (y * w + x) * 4;
				if (o > th) {
					d[i] = 255; d[i + 1] = 138; d[i + 2] = 61; d[i + 3] = 255;
				} else if (tq * 0.75 > th) {
					d[i] = 24; d[i + 1] = 58; d[i + 2] = 56; d[i + 3] = 255;
				} else {
					d[i + 3] = 0;
				}
			}
		}
		ctx!.putImageData(img!, 0, 0);
	}
	const still = () => draw(4.2);
	addTask(
		cv,
		(t) => {
			const s = Math.floor(t * 20); // 20 fps for the retro cadence
			if (s === step) return;
			step = s;
			draw(t);
		},
		still,
	);
	ditherStill = () => {
		step = -1;
		still();
	};
})();

/* ---------------- [words] section H2 word mask-up (v3-2-vector E3) ---------------- */
// Words slide up out of a clip mask when their .reveal enters. The real text stays in a
// .visually-hidden copy; the split copy is aria-hidden.
document.querySelectorAll<HTMLElement>('[data-words]').forEach((el) => {
	if (el.classList.contains('split')) return;
	const sr = document.createElement('span');
	sr.className = 'visually-hidden';
	sr.textContent = (el.textContent || '').replace(/\s+/g, ' ').trim();
	const vis = document.createElement('span');
	vis.setAttribute('aria-hidden', 'true');
	while (el.firstChild) vis.appendChild(el.firstChild);
	let n = 0;
	(function walk(node: Node) {
		Array.from(node.childNodes).forEach((c) => {
			if (c.nodeType === 3) {
				const frag = document.createDocumentFragment();
				(c.textContent || '').split(/(\s+)/).forEach((p) => {
					if (!p) return;
					if (/^\s+$/.test(p)) {
						frag.appendChild(document.createTextNode(p));
						return;
					}
					const w = document.createElement('span');
					w.className = 'mw';
					const wi = document.createElement('span');
					wi.className = 'mwi';
					wi.style.setProperty('--i', String(n++));
					wi.textContent = p;
					w.appendChild(wi);
					frag.appendChild(w);
				});
				node.replaceChild(frag, c);
			} else if (c.nodeType === 1) walk(c);
		});
	})(vis);
	el.appendChild(sr);
	el.appendChild(vis);
	el.classList.add('split');
});

/* ---------------- [stagger] index items inside mocks for line-by-line arrival ---------------- */
document.querySelectorAll('.frame, .cmds').forEach((box) => {
	box
		.querySelectorAll<HTMLElement>('.q-item, .src-row, .supers, .rec-act, .brow, .idrow, .refuse, .tpl, .digest > div, .disk-foot > *, .cmdc')
		.forEach((el, i) => el.style.setProperty('--i', String(i)));
});

/* ---------------- [trace] self-drawing card borders + hover orbit (v3-2-vector E5/E6) ---------------- */
const NS = 'http://www.w3.org/2000/svg';
function svgEl(name: string, attrs: Record<string, string | number>, parent?: Element) {
	const e = document.createElementNS(NS, name);
	for (const k in attrs) e.setAttribute(k, String(attrs[k]));
	if (parent) parent.appendChild(e);
	return e;
}
document.querySelectorAll('.stage, .frame, .os-card, .license').forEach((card) => {
	const s = svgEl('svg', { class: 'trace', 'aria-hidden': 'true', focusable: 'false' });
	['t-line', 't-head', 't-orbit t-glow', 't-orbit'].forEach((cl) => svgEl('rect', { class: cl, pathLength: 100 }, s));
	card.classList.add('has-trace');
	card.appendChild(s);
});

/* ---------------- [rail] circuit rail with travelling packets (v3-2-vector E7) ---------------- */
// Wide screens: in the left margin with 45° jogs, as in v3-2. Narrow screens (gutter < 84px):
// a slim trace inside the left gutter with small jogs and pads that stop short of the text.
const main = document.getElementById('main');
const rail = main ? svgEl('svg', { class: 'rail', 'aria-hidden': 'true', focusable: 'false' }, main) : null;
type RailNode = { y: number; x: number; end: number; g?: Element };
let R: { len: number; pts: number[]; lit: SVGPathElement | null; nodes: RailNode[]; pkts: Element[] } = {
	len: 0, pts: [], lit: null, nodes: [], pkts: [],
};
function offsetIn(el: HTMLElement, anc: HTMLElement) {
	// layout position (ignores reveal/power-on transforms)
	let x = 0;
	let y = 0;
	for (let n: HTMLElement | null = el; n && n !== anc; n = n.offsetParent as HTMLElement | null) {
		x += n.offsetLeft;
		y += n.offsetTop;
	}
	return { x, y };
}
function buildRail() {
	if (!rail || !main) return;
	while (rail.firstChild) rail.removeChild(rail.firstChild);
	R = { len: 0, pts: [], lit: null, nodes: [], pkts: [] };
	const mw = main.clientWidth;
	const wrap = document.querySelector('.wrap');
	const cl = Math.max(0, (mw - 1180) / 2) + (wrap ? parseFloat(getComputedStyle(wrap).paddingLeft) : 16);
	const slim = cl < 84;
	rail.classList.toggle('slim', slim);
	rail.setAttribute('width', String(mw));
	rail.setAttribute('height', String(main.scrollHeight));
	const X = slim ? Math.max(3, Math.round(cl * 0.3)) + 0.5 : Math.round(cl * 0.46) + 0.5;
	const J = slim ? 4 : 14;
	const padEnd = slim ? cl - 5 : cl - 14;
	let lane = X;
	const stage = document.querySelector<HTMLElement>('.stage');
	if (!stage) return;
	const so = offsetIn(stage, main);
	// A stage wider than the column (the context graph) covers the rail's lane, so the rail starts under it instead.
	const covers = so.x <= X + 12;
	let y = Math.round(covers ? so.y + stage.offsetHeight + 24 : so.y + 120) + 0.5;
	const sx = covers ? X : so.x;
	let d = covers ? `M${X} ${y}` : `M${sx} ${y} H${X + 10} L${X} ${y + 10}`;
	if (!covers) y += 10;
	const vias: [number, number][] = [[sx, covers ? y : y - 10]];
	const targets = Array.from(document.querySelectorAll<HTMLElement>('.intro .kicker, .p-num, .marquee, .band .kicker, .final h2'));
	for (const el of targets) {
		const o = offsetIn(el, main);
		const ty = Math.round(o.y + el.offsetHeight / 2) + 0.5;
		if (ty - y > 160) {
			const m = Math.round(y + (ty - y) * 0.38) + 0.5;
			const nx = lane === X ? X + J : X;
			d += ` V${m} L${nx} ${m + J}`;
			vias.push([lane, m]);
			lane = nx;
		}
		d += ` V${ty}`;
		y = ty;
		R.nodes.push({ y: ty, x: lane, end: padEnd });
	}
	d += ` V${y + 90}`;
	const base = svgEl('path', { d, class: 'r-base' }, rail) as SVGPathElement;
	R.lit = svgEl('path', { d, class: 'r-lit' }, rail) as SVGPathElement;
	R.len = base.getTotalLength();
	R.lit.style.strokeDasharray = `${R.len} ${R.len}`;
	R.lit.style.strokeDashoffset = String(R.len);
	for (let L = 0; L <= R.len; L += 3) {
		const p = base.getPointAtLength(L);
		R.pts.push(p.x, p.y);
	}
	const ps = slim ? 5 : 7;
	for (const n of R.nodes) {
		const g = svgEl('g', {}, rail);
		if (n.end - ps / 2 > n.x) svgEl('line', { x1: n.x, y1: n.y, x2: n.end - ps / 2, y2: n.y, class: 'r-stub' }, g);
		svgEl('rect', {
			x: n.end - ps / 2 - 0.5, y: n.y - ps / 2, width: ps, height: ps, class: 'r-pad',
			transform: `rotate(45 ${n.end - 0.5} ${n.y})`,
		}, g);
		n.g = g;
	}
	for (const v of vias) svgEl('circle', { cx: v[0], cy: v[1], r: slim ? 1.8 : 2.6, class: 'r-via' }, rail);
	svgEl('circle', { cx: lane, cy: y + 90, r: slim ? 2 : 3, class: 'r-via' }, rail);
	const cols = ['#ff8a3d', '#ffb07a', '#ff8a3d', '#74e0cc'];
	for (const col of cols) {
		const pg = svgEl('g', { class: 'r-pkt' }, rail);
		svgEl('circle', { r: slim ? 4 : 6, fill: col, 'fill-opacity': '.16' }, pg);
		svgEl('circle', { r: slim ? 1.5 : 1.9, fill: col }, pg);
		R.pkts.push(pg);
	}
	updateLit();
	drawRail(0);
}
function updateLit() {
	if (!R.len || !R.lit || !main) return;
	const on = isOn();
	const vy = window.scrollY + innerHeight * 0.55 - (main.getBoundingClientRect().top + window.scrollY);
	const pts = R.pts;
	let lo = 0;
	let hi = pts.length / 2 - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (pts[mid * 2 + 1] < vy) lo = mid + 1;
		else hi = mid;
	}
	// Motion off: the whole trace is drawn and every node lit, with no packets.
	R.lit.style.strokeDashoffset = String(on ? Math.max(0, R.len - lo * 3) : 0);
	for (const n of R.nodes) n.g?.classList.toggle('on', !on || n.y < vy);
}
function drawRail(t: number) {
	if (!R.len) return;
	const n = R.pts.length / 2;
	const step = R.len / R.pkts.length;
	R.pkts.forEach((p, i) => {
		const L = (t * 110 + i * step) % R.len;
		const j = Math.min(n - 1, Math.floor(L / 3));
		p.setAttribute('transform', `translate(${R.pts[j * 2]} ${R.pts[j * 2 + 1]})`);
	});
}
if (main && rail) {
	addTask(main, drawRail, updateLit, '0px');
	let queued = false;
	addEventListener(
		'scroll',
		() => {
			if (queued) return;
			queued = true;
			requestAnimationFrame(() => {
				queued = false;
				updateLit();
			});
		},
		{ passive: true },
	);
}

/* ---------------- sizing ---------------- */
let rz = 0;
function resizeAll() {
	sizeHero();
	syncCrt();
	buildRail();
	if (!isOn()) stillAll();
	else kick();
}
function stillAll() {
	gridStill();
	ditherStill?.();
	updateLit();
}
resizeAll();
addEventListener('resize', () => {
	clearTimeout(rz);
	rz = window.setTimeout(resizeAll, 150);
});
document.fonts?.ready.then(resizeAll);
addEventListener('load', resizeAll);
if ('ResizeObserver' in window && main) {
	// Rebuild the rail when the page height changes (fonts, images, wrapping).
	let lastH = 0;
	new ResizeObserver(() => {
		const h = main.scrollHeight;
		if (Math.abs(h - lastH) > 4) {
			lastH = h;
			clearTimeout(rz);
			rz = window.setTimeout(resizeAll, 150);
		}
	}).observe(main);
}

/* ---------------- start ---------------- */
if (isOn()) {
	replayBoot();
	armDecode();
	kick();
}

/* ---------------- reduced-motion changes at runtime ---------------- */
// Motion is on unless prefers-reduced-motion asks otherwise; follow the preference live.
function applyMotion(on: boolean) {
	if (on === isOn()) return;
	root.classList.toggle('m-on', on);
	root.classList.toggle('m-off', !on);
	if (on) {
		firstArm = false;
		replayBoot();
		armDecode();
		updateLit();
		kick();
	} else {
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
		disarmDecode();
		hero?.classList.remove('boot');
		document.querySelectorAll('.reveal').forEach((e) => e.classList.add('in'));
		stillAll();
	}
}
const rm = window.matchMedia?.('(prefers-reduced-motion: reduce)');
rm?.addEventListener?.('change', (e) => applyMotion(!e.matches));
