/* Psychological Assessment — WAT → SRT → Stories → OPI
   Pure client-side. Edit the CONFIG block to change timings. */
(function () {
  'use strict';

  /* ---------------- CONFIG ---------------- */
  const CONFIG = {
    wat: { total: 102, fixedCount: 52, randomCount: 48, repeatCount: 2, perWordSec: 15, countdownSec: 5, minRepeatGap: 15 },
    srt: { perSec: 150, countdownSec: 5 },
    story: { viewSec: 30, writeSec: 240, pointerSec: 180, countdownSec: 5 },
    opi: { totalSec: 1800 }, // total time allowed for the whole OPI (30 min)
    rest: { afterWat: 120, afterSrt: 120, beforeOpi: 300 },
  };

  // ADMIN MODE: open the site with ?admin=1 to get a testing panel. Set to false before sharing the link.
  const ADMIN_ENABLED = false;
  const ADMIN = ADMIN_ENABLED && /[?&]admin(=1|=true|&|$)/.test(location.search);
  let speed = 1;

  const PICTURES = ['assets/pic_story1.jpg', 'assets/pic_story2.jpg', 'assets/pic_story3.webp', 'assets/pic_story4.png'];
  const POINTERS = [
    'He forced me to accept…',
    'I won Rs 5 Crore in lottery, then…',
    'We had good relations, but then…',
  ];
  const SCALE = ['Strongly Disagree', 'Disagree', 'Slightly Disagree', 'Neutral', 'Slightly Agree', 'Agree', 'Strongly Agree'];
  const STAGES = ['WAT', 'SRT', 'Stories', 'OPI'];
  const SAVE_KEY = 'psy_assessment_v1';

  /* ---------------- helpers ---------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const screen = $('#screen');
  const fmt = (s) => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const minutes = (s) => (s % 60 === 0 ? s / 60 + ' min' : (s / 60).toFixed(1).replace('.0', '') + ' min');

  let session = freshSession();
  let activeCancel = null; // cancels any running timer
  let activeSkip = null;   // (admin) finishes the running timer immediately
  let timedSection = null; // name of the section currently timed (for tab-leave log)

  function freshSession() {
    return { startedAt: Date.now(), finishedAt: null, gender: null, wat: [], opi: [], opiIdx: 0, stage: 'welcome', attention: [] };
  }
  function save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(session)); } catch (e) {} }
  function loadSaved() {
    try { const s = JSON.parse(localStorage.getItem(SAVE_KEY)); return s && s.stage === 'opi' && !s.finishedAt ? s : null; } catch (e) { return null; }
  }

  /* ---------------- audio ---------------- */
  let audioCtx = null;
  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
  }
  function tone(freq, start, dur, vol) {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    const t = audioCtx.currentTime + start;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t); o.stop(t + dur + 0.05);
  }
  const beep = () => tone(880, 0, 0.22, 0.5);
  const endBeep = () => { tone(660, 0, 0.18, 0.5); tone(440, 0.24, 0.3, 0.5); };

  /* ---------------- wake lock & leaving ---------------- */
  let wakeLock = null;
  async function keepAwake() { try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {} }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && timedSection) {
      session.attention.push({ section: timedSection, at: new Date().toLocaleTimeString() });
    } else if (!document.hidden) keepAwake();
  });
  window.addEventListener('beforeunload', (e) => {
    if (!ADMIN && session.stage !== 'welcome' && session.stage !== 'done') { e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------------- screen rendering ---------------- */
  let showToken = 0;
  async function show(html, mount) {
    const tok = ++showToken;
    screen.classList.add('leaving');
    await sleep(ADMIN ? 40 : 160);
    if (tok !== showToken) return; // a newer screen was requested (admin jump)
    screen.classList.remove('leaving');
    screen.innerHTML = html;
    screen.style.animation = 'none'; void screen.offsetHeight; screen.style.animation = '';
    window.scrollTo({ top: 0 });
    if (mount) mount(screen);
  }

  function setSteps(activeIdx) {
    const bar = $('#topbar'); bar.hidden = activeIdx === null;
    if (activeIdx === null) return;
    $('#steps').innerHTML = STAGES.map((n, i) =>
      `<li class="${i < activeIdx ? 'done' : i === activeIdx ? 'active' : ''}"><span class="n">${i < activeIdx ? '✓' : i + 1}</span><span class="txt">${n}</span></li>`).join('');
  }

  /* ---------------- timer ---------------- */
  // Wall-clock based so background throttling doesn't cause drift.
  function countdown(seconds, onTick, onDone) {
    const sp = speed; // admin can speed timers up; displayed values stay in "real" seconds
    const end = Date.now() + (seconds / sp) * 1000;
    let stopped = false;
    const id = setInterval(() => {
      if (stopped) return;
      const left = ((end - Date.now()) / 1000) * sp;
      if (left <= 0) { stop(); onTick(0, 0); onDone && onDone(); } else onTick(left, left / seconds);
    }, 100);
    function stop() { stopped = true; clearInterval(id); }
    onTick(seconds, 1);
    activeCancel = stop;
    activeSkip = () => { stop(); onTick(0, 0); onDone && onDone(); };
    return stop;
  }

  // Run a "get ready" 5-4-3-2-1 screen, then callback.
  function getReady(title, seconds, next) {
    show(`<div class="card stage">
        <span class="eyebrow">Get ready</span>
        <h1>${title}</h1>
        <div class="big-count" id="cd">${seconds}</div>
        <p class="muted">Starting automatically. Keep your pen and paper ready.</p>
      </div>`, () => {
      let last = null;
      countdown(seconds, (left) => {
        const n = Math.ceil(left); if (n !== last && n > 0) { last = n; $('#cd').textContent = n; tone(520, 0, 0.1, 0.3); }
      }, () => { beep(); next(); });
    });
  }

  /* ---------------- generic screens ---------------- */
  function intro({ eyebrow, title, lead, facts, points, notice, button, stageIdx, onStart }) {
    setSteps(stageIdx);
    show(`<div class="card">
        <span class="eyebrow">${eyebrow}</span>
        <h1>${title}</h1>
        <p class="lead">${lead}</p>
        ${facts ? `<div class="facts">${facts.map(([b, s]) => `<div class="fact"><b>${b}</b><span>${s}</span></div>`).join('')}</div>` : ''}
        <h2>How it works</h2>
        <ul class="checklist">${points.map((p) => `<li>${p}</li>`).join('')}</ul>
        ${notice ? `<div class="notice">${notice}</div>` : ''}
        <div class="actions"><button class="btn" id="go">${button || 'Start'}</button></div>
      </div>`, () => $('#go').addEventListener('click', () => { unlockAudio(); onStart(); }));
  }

  function rest({ seconds, title, text, stageIdx, onDone }) {
    setSteps(stageIdx);
    timedSection = null;
    show(`<div class="card stage">
        <div class="rest-icon">☕</div>
        <span class="eyebrow">Rest</span>
        <h1>${title}</h1>
        <p class="lead">${text}</p>
        <div class="big-count timer" id="rt" style="font-size:3.2rem">${fmt(seconds)}</div>
        <div class="bar"><i id="rb"></i></div>
        <div class="actions" style="justify-content:center"><button class="btn secondary" id="skip">I'm ready — continue now</button></div>
      </div>`, () => {
      const stop = countdown(seconds, (l, f) => { $('#rt').textContent = fmt(l); $('#rb').style.width = (f * 100) + '%'; }, () => { endBeep(); onDone(); });
      $('#skip').addEventListener('click', () => { stop(); onDone(); });
    });
  }

  /* =========================================================
     FLOW
     ========================================================= */
  function welcome() {
    session = freshSession(); setSteps(null); timedSection = null;
    const saved = loadSaved();
    show(`<div class="card">
        <span class="eyebrow">Welcome</span>
        <h1>Psychological Assessment</h1>
        <p class="lead">A guided series of tests. Each part begins with clear instructions, and you start it only when you are ready.</p>
        <div class="facts">
          <div class="fact"><b>1 · WAT</b><span>${minutes(CONFIG.wat.total * CONFIG.wat.perWordSec)} · on paper</span></div>
          <div class="fact"><b>2 · SRT</b><span>${minutes(10 * CONFIG.srt.perSec)} · on paper</span></div>
          <div class="fact"><b>3 · Stories</b><span>7 stories · on paper</span></div>
          <div class="fact"><b>4 · OPI</b><span>${DATA.opi.length} statements · ${minutes(CONFIG.opi.totalSec)} · on screen</span></div>
        </div>
        <h2>Before you begin</h2>
        <ul class="checklist">
          <li>Sit in a <b>quiet room</b> where nobody will disturb you for about <b>1.5 hours</b>.</li>
          <li>Keep a <b>pen</b> and <b>plenty of blank white sheets</b> beside you.</li>
          <li>Turn your <b>sound on</b> — each word and situation starts with a beep.</li>
          <li>Keep this browser tab open and in front. Silence notifications and calls.</li>
          <li>Tests advance <b>automatically</b>. You cannot pause or go back during timed parts.</li>
        </ul>
        ${saved ? `<div class="notice info">You have an unfinished OPI saved on this device (${saved.opiIdx} of ${DATA.opi.length} answered).</div>` : ''}
        <div class="actions">
          <button class="btn" id="go">Begin assessment</button>
          ${saved ? '<button class="btn secondary" id="resume">Resume OPI</button>' : ''}
        </div>
      </div>`, () => {
      $('#go').addEventListener('click', () => { unlockAudio(); keepAwake(); genderScreen(); });
      const r = $('#resume'); if (r) r.addEventListener('click', () => { unlockAudio(); keepAwake(); session = saved; opiRun(); });
    });
  }

  function genderScreen() {
    setSteps(null);
    show(`<div class="card">
        <span class="eyebrow">About you</span>
        <h1>Please select your gender</h1>
        <p class="lead">This is used only to adapt a few situations in the tests so they are suitable for you.</p>
        <div class="choice-row" role="radiogroup" aria-label="Gender">
          <button class="choice" role="radio" aria-checked="false" data-g="male"><span class="ci">♂</span>Male</button>
          <button class="choice" role="radio" aria-checked="false" data-g="female"><span class="ci">♀</span>Female</button>
        </div>
        <div class="actions"><button class="btn" id="go" disabled>Continue</button></div>
      </div>`, () => {
      screen.querySelectorAll('.choice').forEach((b) => b.addEventListener('click', () => {
        session.gender = b.dataset.g;
        screen.querySelectorAll('.choice').forEach((x) => { const on = x === b; x.classList.toggle('sel', on); x.setAttribute('aria-checked', on); });
        $('#go').disabled = false;
      }));
      $('#go').addEventListener('click', () => { unlockAudio(); soundCheck(); });
    });
  }

  function soundCheck() {
    setSteps(null);
    show(`<div class="card">
        <span class="eyebrow">Quick check</span>
        <h1>Can you hear the beep?</h1>
        <p class="lead">Tap the button below. You should hear a short tone. If not, raise your volume and make sure silent mode is off.</p>
        <div class="actions">
          <button class="btn secondary" id="t">🔊 Play test beep</button>
          <button class="btn" id="go">I heard it — continue</button>
        </div>
      </div>`, () => {
      $('#t').addEventListener('click', () => { unlockAudio(); beep(); });
      $('#go').addEventListener('click', () => { unlockAudio(); watIntro(); });
    });
  }

  const restAfterWat = () => rest({ seconds: CONFIG.rest.afterWat, stageIdx: 1, title: 'Take a short rest', text: 'Well done. Relax your hand, drink some water, and get ready for the next test.', onDone: srtIntro });
  const restAfterSrt = () => rest({ seconds: CONFIG.rest.afterSrt, stageIdx: 2, title: 'Take a short rest', text: 'Good work. Stretch a little — the next part uses pictures and story starters.', onDone: storiesIntro });
  const restBeforeOpi = () => rest({ seconds: CONFIG.rest.beforeOpi, stageIdx: 3, title: 'Longer rest before the final test', text: 'You have finished all the paper tests. You may put your pen and papers aside. The last test is on this screen only.', onDone: opiIntro });

  /* ---------------- WAT ---------------- */
  function buildWatSequence() {
    const c = CONFIG.wat;
    const randomCount = c.randomCount;
    const fixed = DATA.watFixed.slice(0, c.fixedCount);
    const random = shuffle(DATA.watPool).slice(0, randomCount);
    let seq = shuffle([...fixed, ...random]).map((w) => ({ word: w, repeat: false }));
    // choose repeat words and place the 2nd occurrence far from the 1st
    const picks = shuffle(seq.map((x) => x.word)).slice(0, c.repeatCount);
    picks.forEach((w) => {
      const first = seq.findIndex((x) => x.word === w);
      let pos, tries = 0;
      do { pos = Math.floor(Math.random() * (seq.length + 1)); tries++; }
      while (Math.abs(pos - first) < c.minRepeatGap && tries < 200);
      seq.splice(pos, 0, { word: w, repeat: true });
    });
    return seq;
  }

  function watIntro() {
    const c = CONFIG.wat;
    intro({
      stageIdx: 0, eyebrow: 'Test 1 of 4', title: 'Word Association Test (WAT)',
      lead: 'Words will appear one at a time. For each word, write the first sentence that comes to your mind.',
      facts: [[c.total + ' words', 'one at a time'], [c.perWordSec + ' seconds', 'per word'], [minutes(c.total * c.perWordSec), 'total time']],
      points: [
        'Number your answers <b>1 to ' + c.total + '</b> and write one sentence per word. Several answers can go on the same sheet.',
        'A <b>beep</b> sounds when each new word appears. It changes automatically after ' + c.perWordSec + ' seconds.',
        'Write quickly and naturally. Do not overthink. Do not leave a word blank — if you are stuck, move on and write for the next one.',
        'The test cannot be paused or rewound.',
      ],
      notice: 'Make sure your pen is working and your sheets are ready. After the countdown the first word appears right away.',
      button: 'Start WAT', onStart: () => getReady('WAT begins', CONFIG.wat.countdownSec, watRun),
    });
  }

  function watRun(startAt = 0) {
    session.stage = 'wat'; timedSection = 'WAT'; setSteps(0);
    if (startAt === 0 || !session.wat.length) session.wat = buildWatSequence();
    const total = session.wat.length, per = CONFIG.wat.perWordSec;
    show(`<div class="card stage">
        <div class="stage-meta"><span>Word <b id="wn">1</b> of ${total}</span><span class="timer" id="wt" style="font-size:1.1rem">${per}</span></div>
        <div class="bar" id="wbar"><i id="wb"></i></div>
        <div class="wat-word" id="ww"></div>
        <p class="hint">Write the first sentence that comes to your mind.</p>
      </div>`, () => {
      let i = Math.min(startAt, total - 1);
      const next = () => {
        if (i >= total) { endBeep(); timedSection = null; return restAfterWat(); }
        const w = $('#ww'); w.textContent = session.wat[i].word;
        w.style.animation = 'none'; void w.offsetHeight; w.style.animation = '';
        $('#wn').textContent = i + 1; beep(); i++;
        countdown(per, (l, f) => { $('#wt').textContent = Math.ceil(l); $('#wb').style.width = (f * 100) + '%'; $('#wbar').classList.toggle('low', l <= 4); }, next);
      };
      next();
    });
  }

  /* ---------------- SRT ---------------- */
  // SRT items contain {opp} / {obj} tokens so the situation involves the OPPOSITE gender of the candidate.
  function srtText(i) {
    const female = session.gender === 'female';
    return DATA.srt[i].text.replace(/\{opp\}/g, female ? 'male' : 'female').replace(/\{obj\}/g, female ? 'him' : 'her');
  }

  function srtIntro() {
    const c = CONFIG.srt, n = DATA.srt.length;
    intro({
      stageIdx: 1, eyebrow: 'Test 2 of 4', title: 'Situation Reaction Test (SRT)',
      lead: 'You will read short real-life situations. Write what you would actually do in each one.',
      facts: [[n + ' situations', 'one at a time'], [minutes(c.perSec), 'per situation'], [minutes(c.perSec * n), 'total time']],
      points: [
        'Number your answers <b>1 to ' + n + '</b>. Write each answer below the previous one — several can share a sheet.',
        'Each situation stays on screen for ' + minutes(c.perSec) + ', then the next one appears automatically with a beep.',
        'Write a clear, practical, honest course of action — what you would really do, step by step.',
        'The test cannot be paused or rewound.',
      ],
      button: 'Start SRT', onStart: () => getReady('SRT begins', c.countdownSec, srtRun),
    });
  }

  function srtRun(startAt = 0) {
    session.stage = 'srt'; timedSection = 'SRT'; setSteps(1);
    const items = DATA.srt, per = CONFIG.srt.perSec;
    show(`<div class="card stage">
        <div class="stage-meta"><span>Situation <b id="sn">1</b> of ${items.length}</span><span class="timer" id="st">${fmt(per)}</span></div>
        <div class="bar" id="sbar"><i id="sb"></i></div>
        <div class="srt-text" id="stx"></div>
        <p class="hint">Write your answer to <b>situation <span id="sh">1</span></b>, and number it on your sheet.</p>
      </div>`, () => {
      let i = Math.min(startAt, items.length - 1);
      const next = () => {
        if (i >= items.length) { endBeep(); timedSection = null; return restAfterSrt(); }
        const t = $('#stx'); t.textContent = srtText(i);
        t.style.animation = 'none'; void t.offsetHeight; t.style.animation = '';
        $('#sn').textContent = i + 1; $('#sh').textContent = i + 1; beep(); i++;
        countdown(per, (l, f) => { $('#st').textContent = fmt(l); $('#sb').style.width = (f * 100) + '%'; $('#sbar').classList.toggle('low', l <= 20); }, next);
      };
      next();
    });
  }

  /* ---------------- Stories ---------------- */
  function storiesIntro() {
    const c = CONFIG.story;
    intro({
      stageIdx: 2, eyebrow: 'Test 3 of 4', title: 'Story Writing',
      lead: 'Write imaginative stories from four pictures and three story starters.',
      facts: [[PICTURES.length + ' pictures', c.viewSec + ' sec to view, ' + minutes(c.writeSec) + ' to write'], [POINTERS.length + ' story starters', minutes(c.pointerSec) + ' each'], ['7 stories', 'on separate sheets']],
      points: [
        '<b>Pictures:</b> each picture is shown for ' + c.viewSec + ' seconds. Then it disappears and you have ' + minutes(c.writeSec) + ' to write a story. Include what led to the scene, what is happening, what the characters are thinking and feeling, and how it ends.',
        '<b>Story starters:</b> you will see the beginning of a sentence. Continue it into a complete story within ' + minutes(c.pointerSec) + '.',
        'Use a fresh sheet for each story and number them <b>1 to 7</b>.',
        'There is no right or wrong story. Write whatever comes naturally.',
      ],
      button: 'Start Stories', onStart: () => getReady('Stories begin', c.countdownSec, storiesRun),
    });
  }

  function storiesRun(startStep = 0) {
    session.stage = 'stories'; timedSection = 'Stories'; setSteps(2);
    const c = CONFIG.story;
    const steps = [];
    PICTURES.forEach((p, i) => { steps.push({ kind: 'view', src: p, n: i + 1 }); steps.push({ kind: 'write', n: i + 1, pic: true }); });
    steps.push({ kind: 'pointerIntro' });
    POINTERS.forEach((t, i) => steps.push({ kind: 'pointer', text: t, n: PICTURES.length + i + 1 }));
    let i = startStep;
    const next = () => {
      if (i >= steps.length) { endBeep(); timedSection = null; return restBeforeOpi(); }
      const s = steps[i++];
      if (s.kind !== 'pointerIntro') beep();
      if (s.kind === 'pointerIntro') {
        show(`<div class="card">
            <span class="eyebrow">Story writing · Part 2</span>
            <h1>Story starters</h1>
            <p class="lead">The picture stories are finished. Next you will see ${POINTERS.length} sentence beginnings, one at a time.</p>
            <ul class="checklist">
              <li>Read the beginning of the sentence and <b>continue it into a complete story</b>.</li>
              <li>You have <b>${minutes(c.pointerSec)}</b> for each one. The next starter appears automatically with a beep.</li>
              <li>Take a <b>fresh sheet</b> for each story and number them <b>${PICTURES.length + 1} to ${PICTURES.length + POINTERS.length}</b>.</li>
              <li>Write the full story, not just a sentence — what happens, who is involved, how it ends.</li>
            </ul>
            <div class="notice info">No timer is running right now. Get a fresh sheet ready, then press the button when you are ready.</div>
            <div class="actions"><button class="btn" id="go">Start story starters</button></div>
          </div>`, () => $('#go').addEventListener('click', () => { unlockAudio(); next(); }));
      } else if (s.kind === 'view') {
        show(`<div class="card stage">
            <div class="stage-meta"><span>Story <b>${s.n}</b> of 7 · Picture</span><span class="phase-chip">Look carefully</span></div>
            <div class="bar"><i id="b"></i></div>
            <div class="pic-wrap"><img src="${s.src}" alt="Picture for story ${s.n}"></div>
            <p class="hint">The picture will disappear in <b id="t">${c.viewSec}</b> seconds. Then write your story.</p>
          </div>`, () => countdown(c.viewSec, (l, f) => { $('#t').textContent = Math.ceil(l); $('#b').style.width = f * 100 + '%'; }, next));
      } else if (s.kind === 'write') {
        show(`<div class="card stage">
            <div class="stage-meta"><span>Story <b>${s.n}</b> of 7 · Picture</span><span class="phase-chip write">Write now</span></div>
            <div class="bar" id="bar"><i id="b"></i></div>
            <div class="rest-icon" style="margin-top:36px">✍️</div>
            <h1>Write your story</h1>
            <p class="lead">What led to this scene, what is happening now, what are they thinking and feeling, and how does it end?</p>
            <div class="timer" id="t" style="margin-top:20px">${fmt(c.writeSec)}</div>
            <p class="hint">Use sheet number ${s.n}.</p>
          </div>`, () => countdown(c.writeSec, (l, f) => { $('#t').textContent = fmt(l); $('#b').style.width = f * 100 + '%'; $('#bar').classList.toggle('low', l <= 30); }, next));
      } else {
        show(`<div class="card stage">
            <div class="stage-meta"><span>Story <b>${s.n}</b> of 7 · Story starter</span><span class="timer" id="t" style="font-size:1.1rem">${fmt(c.pointerSec)}</span></div>
            <div class="bar" id="bar"><i id="b"></i></div>
            <div class="starter">${s.text}</div>
            <p class="hint">Continue this into a complete story on sheet number ${s.n}.</p>
          </div>`, () => countdown(c.pointerSec, (l, f) => { $('#t').textContent = fmt(l); $('#b').style.width = f * 100 + '%'; $('#bar').classList.toggle('low', l <= 30); }, next));
      }
    };
    next();
  }

  /* ---------------- OPI ---------------- */
  function opiIntro() {
    intro({
      stageIdx: 3, eyebrow: 'Test 4 of 4', title: 'Omnibus Personality Inventory (OPI)',
      lead: 'This part is done only on the screen. You will see ' + DATA.opi.length + ' statements about yourself.',
      facts: [[DATA.opi.length + ' statements', 'one at a time'], ['7 choices', 'Strongly Disagree → Strongly Agree'], [minutes(CONFIG.opi.totalSec), 'total time, shown on screen']],
      points: [
        'Read each statement and choose how much you agree or disagree.',
        'There are no right or wrong answers. Answer honestly about <b>how you really are</b>, not how you wish to be.',
        'Your first instinct is usually best. Every statement must be answered.',
        'A <b>timer for the whole test</b> (' + minutes(CONFIG.opi.totalSec) + ') is shown at the top. That is enough time to answer calmly; if it runs out, the test ends automatically.',
        'You can go back with the <b>Previous</b> button. On a keyboard, press keys <b>1–7</b> to answer.',
      ],
      button: 'Start OPI', onStart: () => { session.opi = new Array(DATA.opi.length).fill(null); session.opiIdx = 0; session.opiStart = Date.now(); session.timeUp = false; opiRun(); },
    });
  }

  function opiRun() {
    session.stage = 'opi'; timedSection = null; setSteps(3);
    if (activeCancel) activeCancel();
    if (!session.opiStart) session.opiStart = Date.now();
    const total = DATA.opi.length;
    if (!session.opi || session.opi.length !== total) session.opi = new Array(total).fill(null);
    save();
    show(`<div class="card">
        <div class="opi-head"><b>Statement <span id="no" style="color:inherit;font-size:inherit"></span></b><span class="opi-timer" id="otw" title="Time left for the whole OPI">⏱ <b id="otm"></b></span></div>
        <div class="bar"><i id="pb"></i></div>
        <div class="opi-statement" id="os"></div>
        <div class="scale" id="sc" role="radiogroup">
          ${SCALE.map((l, k) => `<button class="opt" role="radio" data-v="${k + 1}" aria-label="${l}"><span class="dot"></span><span class="num">${k + 1}</span><span class="lbl">${l}</span></button>`).join('')}
        </div>
        <div class="opi-nav">
          <button class="btn secondary" id="prev">← Previous</button>
          <span class="small" id="hint">Tip: press 1–7</span>
          <button class="btn" id="nx">Next →</button>
        </div>
      </div>`, () => {
      let busy = false;
      const render = () => {
        const i = session.opiIdx, ans = session.opi[i];
        $('#no').textContent = (i + 1) + ' of ' + total;
        $('#pb').style.width = (i / total) * 100 + '%';
        const os = $('#os'); os.textContent = DATA.opi[i];
        os.style.animation = 'none'; void os.offsetHeight; os.style.animation = '';
        screen.querySelectorAll('.opt').forEach((b) => { const on = +b.dataset.v === ans; b.classList.toggle('sel', on); b.setAttribute('aria-checked', on); });
        $('#prev').disabled = i === 0;
        $('#nx').disabled = ans == null;
        $('#nx').textContent = i === total - 1 ? 'Finish ✓' : 'Next →';
      };
      const go = (d) => {
        if (d > 0 && session.opi[session.opiIdx] == null) return;
        const n = session.opiIdx + d;
        if (n < 0) return;
        if (n >= total) { return finish(); }
        session.opiIdx = n; save(); render();
      };
      const pick = (v) => {
        if (busy) return; session.opi[session.opiIdx] = v; save(); render();
        busy = true; setTimeout(() => { busy = false; go(1); }, 280);
      };
      screen.querySelectorAll('.opt').forEach((b) => b.addEventListener('click', () => pick(+b.dataset.v)));
      $('#prev').addEventListener('click', () => { if (!busy) go(-1); });
      $('#nx').addEventListener('click', () => { if (!busy) go(1); });
      const key = (e) => {
        if (session.stage !== 'opi' || !$('#sc')) return document.removeEventListener('keydown', key);
        if (e.key >= '1' && e.key <= '7') pick(+e.key);
        else if (e.key === 'ArrowLeft') go(-1);
        else if (e.key === 'ArrowRight' || e.key === 'Enter') go(1);
      };
      document.addEventListener('keydown', key);
      render();
      // One timer for the whole OPI. Based on the saved start time, so a page refresh cannot reset it.
      const remaining = CONFIG.opi.totalSec - (Date.now() - session.opiStart) / 1000;
      if (remaining <= 0) { session.timeUp = true; return finish(); }
      countdown(remaining, (l) => {
        $('#otm').textContent = fmt(l);
        $('#otw').classList.toggle('low', l <= 300);
      }, () => { session.timeUp = true; endBeep(); finish(); });
    });
  }

  /* ---------------- Finish & report ---------------- */
  function finish() {
    if (activeCancel) activeCancel();
    activeSkip = null;
    session.stage = 'done'; session.finishedAt = Date.now();
    try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} }
    setSteps(null);
    const mins = Math.round((session.finishedAt - session.startedAt) / 60000);
    show(`<div class="card">
        <div class="done-ring">✓</div>
        <span class="eyebrow">Completed</span>
        <h1>Assessment complete</h1>
        <p class="lead">Thank you. Please download your OPI report below and send it, together with all your written sheets, to the person who shared this link.</p>
        <div class="summary">
          <div><span>OPI statements answered</span><b>${session.opi.filter((x) => x != null).length} / ${DATA.opi.length}</b></div>
          <div><span>Total session time</span><b>${mins} min</b></div>
        </div>
        <div class="actions">
          <button class="btn" id="dl">⬇ Download report (.docx)</button>
          <button class="btn secondary" id="dt">Download as text (.txt)</button>
        </div>
        ${session.timeUp ? '<div class="notice">The OPI time ended automatically. Statements not reached are marked “NOT ANSWERED” in the report.</div>' : ''}
        <div class="notice info">Do not close this page until the file has downloaded. Keep your paper sheets in order (WAT, SRT, Stories).</div>
      </div>`, () => {
      $('#dl').addEventListener('click', downloadDocx);
      $('#dt').addEventListener('click', downloadTxt);
    });
  }

  const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()); };
  const dateStr = () => new Date(session.finishedAt || Date.now()).toLocaleString();
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function repeats() {
    const seen = {}, out = [];
    session.wat.forEach((x, i) => { (seen[x.word] = seen[x.word] || []).push(i + 1); });
    Object.keys(seen).forEach((w) => { if (seen[w].length > 1) out.push({ word: w, positions: seen[w] }); });
    return out;
  }

  function downloadTxt() {
    const L = [];
    L.push('OMNIBUS PERSONALITY INVENTORY (OPI) — RESPONSE REPORT');
    L.push('Date: ' + dateStr());
    L.push('Candidate gender: ' + (session.gender || 'not given'));
    L.push('Scale: 1 Strongly Disagree | 2 Disagree | 3 Slightly Disagree | 4 Neutral | 5 Slightly Agree | 6 Agree | 7 Strongly Agree');
    L.push('');
    DATA.opi.forEach((s, i) => { const v = session.opi[i]; L.push(String(i + 1).padStart(3) + '. ' + s + '  ->  ' + (v ? SCALE[v - 1] + ' (' + v + ')' : 'NOT ANSWERED')); });
    L.push('');
    L.push('WAT WORD ORDER (to match with the paper sheets)');
    session.wat.forEach((x, i) => L.push(String(i + 1).padStart(3) + '. ' + x.word + (x.repeat ? '   [REPEATED WORD]' : '')));
    L.push('');
    L.push('Repeated words: ' + (repeats().map((r) => r.word + ' (#' + r.positions.join(', #') + ')').join('; ') || 'none'));
    L.push('OPI time limit reached: ' + (session.timeUp ? 'YES (unanswered statements: ' + session.opi.filter((x) => x == null).length + ')' : 'no'));
    L.push('Times the candidate left the tab during timed tests: ' + session.attention.length);
    download(new Blob([L.join('\n')], { type: 'text/plain;charset=utf-8' }), 'OPI-Report_' + stamp() + '.txt');
  }

  async function downloadDocx() {
    const D = window.docx;
    if (!D) return downloadTxt();
    const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, WidthType, ShadingType, HeadingLevel, AlignmentType, BorderStyle } = D;
    const border = { style: BorderStyle.SINGLE, size: 4, color: 'CBD0E0' };
    const borders = { top: border, bottom: border, left: border, right: border };
    const cell = (text, w, o = {}) => new TableCell({
      width: { size: w, type: WidthType.PERCENTAGE }, borders,
      shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
      margins: { top: 70, bottom: 70, left: 120, right: 120 },
      children: [new Paragraph({ children: [new TextRun({ text: String(text), bold: !!o.bold, color: o.color, size: 21 })] })],
    });
    const p = (text, o = {}) => new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text, size: 22, bold: !!o.bold, italics: !!o.italics })] });

    const opiRows = [new TableRow({ tableHeader: true, children: [cell('#', 7, { bold: true, fill: 'E7E9F7' }), cell('Statement', 63, { bold: true, fill: 'E7E9F7' }), cell('Selected option', 30, { bold: true, fill: 'E7E9F7' })] })];
    DATA.opi.forEach((s, i) => {
      const v = session.opi[i];
      opiRows.push(new TableRow({ cantSplit: true, children: [cell(i + 1, 7), cell(s, 63), cell(v ? SCALE[v - 1] + ' (' + v + ')' : 'NOT ANSWERED', 30, { bold: true, color: v ? '3730A3' : 'B91C1C' })] }));
    });
    const watRows = [new TableRow({ tableHeader: true, children: [cell('#', 12, { bold: true, fill: 'E7E9F7' }), cell('Word shown', 58, { bold: true, fill: 'E7E9F7' }), cell('Note', 30, { bold: true, fill: 'E7E9F7' })] })];
    session.wat.forEach((x, i) => watRows.push(new TableRow({ cantSplit: true, children: [cell(i + 1, 12), cell(x.word, 58), cell(x.repeat ? 'Repeated word (2nd appearance)' : '', 30, { color: 'B45309' })] })));

    const rep = repeats();
    const doc = new Document({
      creator: 'Psychological Assessment', title: 'OPI Response Report',
      styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
      sections: [{
        properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: 'OPI Response Report', bold: true })] }),
          p('Omnibus Personality Inventory — ' + DATA.opi.length + ' statements, 7-point agreement scale'),
          p('Date completed: ' + dateStr()),
          p('Candidate gender: ' + (session.gender || 'not given')),
          p('Scale: 1 Strongly Disagree · 2 Disagree · 3 Slightly Disagree · 4 Neutral · 5 Slightly Agree · 6 Agree · 7 Strongly Agree', { italics: true }),
          new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 160 }, children: [new TextRun('Part 1 — OPI responses')] }),
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: opiRows }),
          new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, spacing: { after: 160 }, children: [new TextRun('Part 2 — WAT word order')] }),
          p('Use this list to match each handwritten WAT sentence to the word that was shown. Words differ for every candidate and were shown for ' + CONFIG.wat.perWordSec + ' seconds each.'),
          p('Repeated words (to examine consistency / rigidity): ' + (rep.map((r) => r.word + ' — shown at #' + r.positions.join(' and #')).join('; ') || 'none'), { bold: true }),
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: watRows }),
          new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 160 }, children: [new TextRun('Part 3 — Session notes')] }),
          p('Times the candidate left or switched away from the page during timed tests: ' + session.attention.length + (session.attention.length ? ' (' + session.attention.map((a) => a.section + ' @ ' + a.at).join(', ') + ')' : '')),
          p('OPI time limit (' + minutes(CONFIG.opi.totalSec) + ') reached: ' + (session.timeUp ? 'YES — unanswered statements: ' + session.opi.filter((x) => x == null).length : 'no')),
          p('Total session time: ' + Math.round((session.finishedAt - session.startedAt) / 60000) + ' minutes'),
        ],
      }],
    });
    const blob = await Packer.toBlob(doc);
    download(blob, 'OPI-Report_' + stamp() + '.docx');
  }


  /* ---------------- ADMIN / TEST PANEL (?admin=1) ---------------- */
  let adminGender = 'male';
  function initAdmin() {
    const total = DATA.opi.length;
    const ensureSession = () => {
      if (!session.gender) session.gender = adminGender;
      if (!session.wat.length) session.wat = buildWatSequence();
      if (!session.opi || session.opi.length !== total) session.opi = new Array(total).fill(null);
    };
    const go = (fn) => () => { unlockAudio(); if (activeCancel) activeCancel(); activeSkip = null; timedSection = null; ensureSession(); fn(); };
    const storyStep = (n) => (n <= PICTURES.length ? 2 * (n - 1) : n + 4);

    const sections = [
      ['Welcome', () => welcome()],
      ['WAT intro', () => watIntro()], ['WAT run', () => watRun(0)], ['Rest 1', () => restAfterWat()],
      ['SRT intro', () => srtIntro()], ['SRT run', () => srtRun(0)], ['Rest 2', () => restAfterSrt()],
      ['Stories intro', () => storiesIntro()], ['Stories run', () => storiesRun(0)], ['Rest 3 (pre-OPI)', () => restBeforeOpi()],
      ['OPI intro', () => opiIntro()], ['OPI run', () => { session.opiIdx = 0; session.opiStart = null; session.timeUp = false; opiRun(); }],
      ['Finish (random OPI)', () => { session.opi = session.opi.map(() => 1 + Math.floor(Math.random() * 7)); finish(); }],
    ];
    const kinds = {
      WAT: [CONFIG.wat.total, (n) => watRun(n - 1)],
      SRT: [DATA.srt.length, (n) => srtRun(n - 1)],
      Story: [PICTURES.length + POINTERS.length, (n) => storiesRun(storyStep(n))],
      OPI: [total, (n) => { session.opiIdx = n - 1; session.opiStart = null; session.timeUp = false; opiRun(); }],
    };

    const el = document.createElement('div');
    el.className = 'admin';
    el.innerHTML = `
      <button class="admin-fab" id="ad-fab" title="Admin / test panel">⚙ Admin</button>
      <div class="admin-panel" id="ad-panel" hidden>
        <div class="admin-title"><b>Admin test mode</b><button id="ad-x" aria-label="Close">✕</button></div>
        <div class="admin-row"><span>Timer speed</span>
          ${[1, 5, 20, 100].map((x) => `<button class="chip${x === 1 ? ' on' : ''}" data-sp="${x}">${x}×</button>`).join('')}
        </div>
        <div class="admin-row"><span>Test as</span>
          <button class="chip on" data-gd="male">Male</button><button class="chip" data-gd="female">Female</button></div>
        <div class="admin-row"><button class="chip warn" id="ad-skip">⏭ Skip current timer / item</button></div>
        <div class="admin-sub">Jump to section</div>
        <div class="admin-grid">${sections.map((x, i) => `<button class="chip" data-sec="${i}">${x[0]}</button>`).join('')}</div>
        <div class="admin-sub">Jump to item</div>
        <div class="admin-row">
          <select id="ad-kind">${Object.keys(kinds).map((k) => `<option>${k}</option>`).join('')}</select>
          <input id="ad-n" type="number" min="1" value="1">
          <span id="ad-max" class="muted small"></span>
          <button class="chip on" id="ad-go">Go</button>
        </div>
        <div class="admin-row"><button class="chip" id="ad-fill">Fill remaining OPI randomly</button><button class="chip" id="ad-reset">Reset all</button></div>
        <div class="admin-status small muted" id="ad-st"></div>
      </div>`;
    document.body.appendChild(el);
    const $a = (q) => el.querySelector(q);
    const upd = () => { const mx = kinds[$a('#ad-kind').value][0]; $a('#ad-max').textContent = '/ ' + mx; $a('#ad-n').max = mx; };
    upd();
    $a('#ad-kind').addEventListener('change', upd);
    $a('#ad-fab').addEventListener('click', () => { $a('#ad-panel').hidden = !$a('#ad-panel').hidden; });
    $a('#ad-x').addEventListener('click', () => { $a('#ad-panel').hidden = true; });
    el.querySelectorAll('[data-sp]').forEach((b) => b.addEventListener('click', () => {
      speed = +b.dataset.sp;
      el.querySelectorAll('[data-sp]').forEach((x) => x.classList.toggle('on', x === b));
    }));
    el.querySelectorAll('[data-sec]').forEach((b) => b.addEventListener('click', go(sections[+b.dataset.sec][1])));
    $a('#ad-go').addEventListener('click', () => {
      const [mx, fn] = kinds[$a('#ad-kind').value];
      const n = Math.max(1, Math.min(mx, parseInt($a('#ad-n').value, 10) || 1));
      go(() => fn(n))();
    });
    el.querySelectorAll('[data-gd]').forEach((b) => b.addEventListener('click', () => {
      adminGender = b.dataset.gd; session.gender = adminGender;
      el.querySelectorAll('[data-gd]').forEach((x) => x.classList.toggle('on', x === b));
    }));
    $a('#ad-skip').addEventListener('click', () => { if (activeSkip) activeSkip(); });
    $a('#ad-fill').addEventListener('click', () => {
      ensureSession();
      session.opi = session.opi.map((v) => v || 1 + Math.floor(Math.random() * 7));
      save();
      if (session.stage === 'opi') opiRun();
    });
    $a('#ad-reset').addEventListener('click', () => {
      try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
      if (activeCancel) activeCancel();
      activeSkip = null;
      welcome();
    });
    setInterval(() => {
      $a('#ad-st').textContent = 'gender: ' + (session.gender || '-') + ' · stage: ' + session.stage + ' · WAT words: ' + session.wat.length +
        ' · OPI answered: ' + (session.opi || []).filter((x) => x != null).length;
    }, 500);
  }

  /* ---------------- boot ---------------- */
  if (ADMIN) initAdmin();
  welcome();
})();
