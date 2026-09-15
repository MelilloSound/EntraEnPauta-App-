import { chromium } from 'playwright';
import fs from 'fs';
const SRC = fs.readFileSync(new URL('../footer-ms4.js', import.meta.url),'utf8');
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium' });
const out = [];
for (const w of [1440, 768, 390]) {
  const pg = await b.newPage({ viewport:{ width:w, height:900 } });
  await pg.goto(new URL('fixture.html', import.meta.url).href);
  await pg.evaluate(() => document.documentElement.classList.add('b33'));   // bloque 33 activo
  const before = await pg.evaluate(() => [...document.querySelectorAll('h2')].map(h=>({
    t:h.innerText.replace(/\s+/g,' ').slice(0,26),
    cell:Math.round(h.clientWidth), fs:Math.round(parseFloat(getComputedStyle(h).fontSize)),
    parte:h.scrollWidth<=h.clientWidth+1 && h.getBoundingClientRect().height > parseFloat(getComputedStyle(h).lineHeight)*1.5
  })));
  await pg.addScriptTag({ content: SRC });
  await pg.waitForTimeout(400);
  const after = await pg.evaluate(() => ({
    heads:[...document.querySelectorAll('h2')].map(h=>({
      t:h.innerText.replace(/\s+/g,' ').slice(0,26),
      cell:Math.round(h.clientWidth),
      fs:Math.round(parseFloat(getComputedStyle(h).fontSize)),
      inline:h.style.fontSize||'(sin estilo en línea)',
      desborda:h.scrollWidth>h.clientWidth+1
    })),
    num:document.querySelector('.ms-num').style.fontSize||'(intacto)',
    closer:document.querySelectorAll('p.ms-closer').length,
    steps:window.__ms4.steps.map(s=>s.step+':'+s.n)
  }));
  // idempotencia: dos resize seguidos
  await pg.setViewportSize({width:w-1,height:900}); await pg.waitForTimeout(300);
  await pg.setViewportSize({width:w,height:900});   await pg.waitForTimeout(300);
  const again = await pg.evaluate(() => [...document.querySelectorAll('h2')].map(h=>h.style.fontSize||'-'));
  out.push({ w, before, after, tras_dos_resize: again });
  await pg.close();
}
await b.close();
console.log(JSON.stringify(out,null,1));
