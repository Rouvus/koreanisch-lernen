/* Service Worker der Lern-App.
   ---------------------------------------------------------------
   Aufgabe: Die App soll nach dem ersten Besuch komplett ohne Netz
   starten. Weil die ganze App in einer einzigen HTML-Datei steckt
   (Schrift, Bilder und Logik inklusive), ist das erfreulich einfach:
   wir legen eine Handvoll Dateien ab und liefern sie danach aus dem
   Gerät aus.

   Strategie:
   - App-Dateien: erst aus dem Speicher (schneller Start), im
     Hintergrund wird geprüft, ob es eine neue Fassung gibt.
   - Aufrufe der App selbst: immer index.html aus dem Speicher, damit
     ein Start ohne Netz nie auf einer Fehlerseite landet.
   - Andere Seiten (datenschutz.html): erst aus dem Netz, ohne Netz aus
     dem Speicher.
   - Sprachaufnahmen: in einem EIGENEN Speicher, der neue Fassungen
     überlebt.

   VERSION wird beim Bauen (build-pwa.sh) automatisch gesetzt. Ändert
   sich die App, ändert sich die Version, und der alte Speicher wird
   verworfen — der für die Aufnahmen ausdrücklich nicht. */
const VERSION = 'd959f7e6417f';
const CACHE = 'koreanisch-' + VERSION;
/* Ohne Version im Namen, und das ist der ganze Punkt: Die Dateinamen
   der Aufnahmen sind Prüfsummen ihres Textes, eine Datei ändert sich
   also nie. Lägen sie im versionierten Speicher, würde jede neue
   Fassung der App rund 9 MB Aufnahmen wegwerfen und neu laden — und
   wer gerade mit schlechtem Netz aktualisiert, hätte danach im Zug
   keine Aussprache mehr. */
const AUDIO_CACHE = 'koreanisch-audio';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];
/* Nicht in ASSETS, weil addAll alles oder nichts ist: Fehlte die Seite
   einmal, ließe sich die ganze App nicht mehr installieren. */
const EXTRA = ['./datenschutz.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      /* cache:'reload' ist wichtig: Ohne das darf der Browser die Dateien
         aus seinem EIGENEN Zwischenspeicher nehmen — und legt dann eine
         alte Fassung als "neu" ab. Manche Webspeicher (u. a. GitHub
         Pages) erlauben ihm das für einige Minuten. */
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))
        .then(() => Promise.allSettled(EXTRA.map((u) => cache.add(new Request(u, { cache: 'reload' }))))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => migrateAudio(keys).then(() => keys))
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE && k !== AUDIO_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => precacheAudio())
  );
});

/* Bis Version 1.25.0 lagen die Aufnahmen im versionierten Speicher.
   Bevor der weggeräumt wird, ziehen sie einmalig in den neuen um —
   sonst müsste beim Umstieg jeder die 9 MB noch ein letztes Mal laden. */
async function migrateAudio(keys) {
  try {
    const audio = await caches.open(AUDIO_CACHE);
    for (const name of keys) {
      if (name === CACHE || name === AUDIO_CACHE) continue;
      const old = await caches.open(name);
      for (const req of await old.keys()) {
        if (!isAudioFile(new URL(req.url))) continue;
        if (await audio.match(req)) continue;
        const res = await old.match(req);
        if (res && res.ok) await audio.put(req, res);
      }
    }
  } catch (err) {
    /* Umzug gescheitert — dann lädt precacheAudio eben nach */
  }
}

function isAudioFile(url) {
  return url.pathname.indexOf('/audio/') !== -1 && url.pathname.endsWith('.mp3');
}

/* Die Sprachaufnahmen im Hintergrund nachladen.
   Sie werden zwar ohnehin beim ersten Abspielen abgelegt (s. fetch weiter
   unten) — aber genau darauf darf man sich nicht verlassen: Wer die App
   installiert und dann im Zug ohne Netz lernt, hätte sonst Aufnahmen nur
   für die Wörter, die er zufällig schon einmal angehört hat.
   Geladen wird nur, was noch fehlt; im Normalfall ist das nach einem
   Update nichts. Aufnahmen, die das Verzeichnis nicht mehr nennt (etwa
   nach einem Neuaufbau mit anderer Stimme), werden weggeräumt.
   Bewusst in kleinen Gruppen und mit allSettled: eine einzelne fehlende
   Datei darf den ganzen Vorgang nicht abbrechen. Fehlt der Ordner ganz
   (noch keine Aufnahmen erzeugt), endet das hier still nach dem 404. */
async function precacheAudio() {
  try {
    const res = await fetch('./audio/index.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const data = await res.clone().json();
    if (!data || !Array.isArray(data.items)) return;
    await (await caches.open(CACHE)).put('./audio/index.json', res);

    const audio = await caches.open(AUDIO_CACHE);
    const wanted = new Set(data.items.map((it) => new URL('./audio/' + it.file, self.location).href));
    for (const req of await audio.keys()) {
      if (!wanted.has(req.url)) await audio.delete(req);
    }
    const missing = [];
    for (const url of wanted) {
      if (!(await audio.match(url))) missing.push(url);
    }
    for (let i = 0; i < missing.length; i += 20) {
      await Promise.allSettled(missing.slice(i, i + 20).map((u) => audio.add(u)));
    }
  } catch (err) {
    /* keine Aufnahmen vorhanden oder kein Netz — beides unkritisch */
  }
}

/* Ist das ein Aufruf der App selbst? Der Ordner (./) und index.html —
   alles andere ist eine eigene Seite und bekommt auch ihren eigenen
   Inhalt. Vorher bekam JEDER Seitenaufruf die App, auch die
   Datenschutzerklärung: Wer die App einmal geöffnet hatte, sah unter
   datenschutz.html danach nur noch die App. */
function isAppNavigation(url) {
  const scope = new URL(self.registration.scope).pathname;
  return url.pathname === scope || url.pathname === scope + 'index.html';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Jeder Start der App bekommt die App-Datei — auch offline.
    if (isAppNavigation(url)) {
      event.respondWith(
        caches.match('./index.html').then((hit) => hit || fetch(req))
      );
      return;
    }
    /* Andere Seiten: so, wie sie auf dem Server liegen. Ohne Netz die
       abgelegte Fassung, und gibt es keine, wenigstens die App statt
       einer Fehlerseite des Browsers. */
    event.respondWith(
      fetch(req).catch(() =>
        caches.match(req, { ignoreSearch: true })
          .then((hit) => hit || caches.match('./index.html'))
      )
    );
    return;
  }

  /* Zwei Verzeichnisdateien, ein Grund: Beide sagen, WAS es gibt — die
     eine, welcher Kursstand draußen liegt, die andere, welche Aufnahmen
     vorhanden sind. Aus dem Vorrat bedient würden sie melden, was es
     GESTERN gab. Bei den Aufnahmen fällt das besonders unangenehm auf,
     wenn später mit einer anderen Stimme neu erzeugt wird: Die App läse
     weiter das alte Verzeichnis und spielte Dateien ab, die es so nicht
     mehr gibt. */
  if (url.pathname.endsWith('/kurs.json') || url.pathname.endsWith('/audio/index.json')) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  /* Die MP3s selbst: Vorrat zuerst und kein Nachfragen beim Server —
     sie ändern sich nie, und sie sind der Grund, warum die App auch im
     Zug ohne Netz klingt. */
  if (isAudioFile(url)) {
    event.respondWith(
      caches.open(AUDIO_CACHE).then((audio) =>
        audio.match(req).then((hit) => hit || fetch(req).then((res) => {
          if (res && res.ok) audio.put(req, res.clone());
          return res;
        }))
      )
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      const fromNet = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || fromNet;
    })
  );
});
