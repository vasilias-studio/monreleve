/**
 * engine.js — Calcul « en direct » à la Excel pour les grilles de notes HTML.
 *
 * Pas de second moteur : le fichier server/compute.js (le moteur officiel, celui du serveur)
 * est lu, ses mots-clés `export` retirés, puis inliné dans la page. Le navigateur exécute
 * DONC littéralement le même code que le serveur → ce que vous voyez pendant la frappe est
 * exactement ce qui sera enregistré. Sans JavaScript, la page fonctionne comme avant
 * (recalcul à l'enregistrement du formulaire).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPUTE_PATH = path.join(__dirname, '..', 'compute.js');

let cached = null;
/** Source du moteur (IIFE exposant window.__MRE) — lue une fois, puis en cache. */
export function engineSource() {
  if (!cached) {
    const src = fs.readFileSync(COMPUTE_PATH, 'utf8').replace(/^export\s+/gm, '');
    cached = 'window.__MRE=(function(){\n' + src + '\nreturn { computeReleve, finalGrade, courseStatus, creditsEarned, round2, resolveRules };})();';
  }
  return cached;
}

/**
 * Script complet = moteur + config de la page + glue DOM.
 * cfg : { rules, tree, source }  — tree = semestres bruts (loadTemplateTree),
 *        source = {courseId:{normal,rattrapage}} (notes déjà en base pour la source affichée).
 */
export function liveCalcScript(cfg) {
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c'); // sécurité anti-injection dans <script>
  return `<script>${engineSource()}
window.MRLIVE=${json};
(function(){
  var cfg=window.MRLIVE, tpl={rules_json:JSON.stringify(cfg.rules)};
  // {courseId: {normal, rattrapage}} — mutable, alimenté par la frappe
  var scores={}; for(var k in cfg.source){ scores[k]={normal:cfg.source[k].normal, rattrapage:cfg.source[k].rattrapage}; }
  var fmt2=function(v){ return (v==null||isNaN(v))?'—':Number(v).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2}); };
  var ST={validee:['Validée','ok'],non_validee:['Non validée','bad'],rattrapage_a_passer:['Rattrapage à passer','warn'],en_attente:['En attente','gray']};
  function toMap(){ var m=new Map(); for(var id in scores) m.set(Number(id), scores[id]); return m; }
  function paint(){
    var out=window.__MRE.computeReleve(tpl, cfg.tree, toMap());
    out.semesters.forEach(function(sem){
      var sa=document.getElementById('sa'+sem.id); if(sa) sa.textContent=fmt2(sem.average);
      var topSa=document.getElementById('topsa'+sem.id); if(topSa) topSa.textContent=fmt2(sem.average);
      var tab=document.getElementById('tab'+sem.id); if(tab) tab.innerHTML='S'+sem.number+(sem.average!=null?' · '+fmt2(sem.average):'');
      sem.units.forEach(function(u){
        var ue=document.getElementById('ue'+u.id); if(ue) ue.textContent=fmt2(u.average);
        u.courses.forEach(function(c){
          var d=document.getElementById('def'+c.id); if(d) d.textContent=fmt2(c.definitive);
          var st=document.getElementById('st'+c.id);
          if(st){ var lab=ST[c.status]||[c.status,'gray']; st.innerHTML='<span class="chip '+lab[1]+'">'+lab[0]+'</span>'; }
          var ce=document.getElementById('ce'+c.id); if(ce) ce.textContent=fmt2(c.creditsEarned,0)+'/'+fmt2(c.credits,0);
        });
      });
    });
    var ga=document.getElementById('ga'); if(ga) ga.textContent=fmt2(out.generalAverage);
    var dirty=document.getElementById('dirty'); if(dirty) dirty.style.display='none';
  }
  document.addEventListener('input', function(e){
    var m=e.target && e.target.name && e.target.name.match(/^([nr])_(\\d+)$/);
    if(!m) return;
    if(e.target.disabled) return;
    var raw=String(e.target.value||'').trim().replace(',','.');
    var v=raw===''?null:Number(raw);
    if(v!==null && !isFinite(v)) return;
    var id=m[2]; if(!scores[id]) scores[id]={};
    scores[id][m[1]==='n'?'normal':'rattrapage']=(v===null||isNaN(v))?null:v;
    var dirty=document.getElementById('dirty'); if(dirty) dirty.style.display='';
    paint();
  });
  paint();
})();
</script>`;
}
