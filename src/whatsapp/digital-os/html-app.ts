/**
 * Digital OS — HTML-primitive UI (slot-machine container).
 *
 * Renders the app drawer / Anti System screens as custom HTML+CSS+JS injected
 * into the same FOAHtmlPrimitiveDemoDONOTUSE rich-response bubble that
 * plogme's `sendSlotMachine` uses (`botForwardedMessage.message
 * .richResponseMessage.unifiedResponse.sections[].view_model.primitive`).
 *
 * Interaction channel (beacon):
 *   - HTML never talks to the network. Every control is an <a> whose href is
 *     `https://wa.me/<botNumber>?text=.ic <token> <op> <rowid> <value>`.
 *   - Tapping morphs the bubble locally (JS flips [ ]->[✓], highlights the
 *     active action, hides/shows the warn stepper) and then navigates the deep
 *     link, pre-filling the owner's DM to the bot with the backend command.
 *   - The bot's `.ic` handler mutates the same server-side draft state, so
 *     re-renders/navigation/Done always reflect authoritative state.
 *
 * Layout is tuned for small phone viewports: single-line rows, tight padding,
 * no double spacing. This module is pure (no I/O) and unit-testable.
 */
import type { DosRow } from "./builder.js";
import { renderDosPage } from "./builder.js";

export interface DosHtmlBuildInput {
  token: string;
  botNumber: string;
  title: string;
  rows: DosRow[];
  page?: number;
  maxButtons?: number;
  showDone?: boolean;
  showBack?: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

/** Beacon deep-link: wa.me/<bot>?text=.ic <token> <op> <rowid> <value> */
export function dosBeaconUrl(
  botNumber: string,
  token: string,
  op: string,
  rowId?: string,
  value?: string,
): string {
  const parts = [".ic", token, op];
  if (rowId) parts.push(rowId);
  if (value !== undefined) parts.push(value);
  return `https://wa.me/${encodeURIComponent(botNumber)}?text=${encodeURIComponent(parts.join(" "))}`;
}

const DOS_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;background:transparent;font:13px/1.25 -apple-system,'Segoe UI',Roboto,sans-serif;color:#111;overscroll-behavior:none;-webkit-text-size-adjust:100%}
.os{background:linear-gradient(160deg,#0f172a,#1e293b 55%,#0b1120);border-radius:18px;padding:10px 9px 12px;box-shadow:0 0 0 2px #334155,0 10px 24px rgba(0,0,0,.35)}
.status{display:flex;gap:4px;align-items:center;padding:1px 2px 7px}
.status i{width:7px;height:7px;border-radius:50%;display:inline-block}
.status .r{background:#f87171}.status .y{background:#fbbf24}.status .g{background:#34d399}
.status b{margin-left:auto;color:#cbd5e1;font-size:10px;letter-spacing:.4px}
.h{display:flex;align-items:center;gap:6px;padding:0 2px 8px;color:#f8fafc}
.h .ttl{font:800 15px/1.1 -apple-system,sans-serif;letter-spacing:.2px}
.h .pg{margin-left:auto;color:#94a3b8;font-size:10px}
.rows{display:flex;flex-direction:column;gap:6px}
.row{display:flex;align-items:center;gap:6px;background:#ffffff0d;border:1px solid #ffffff1f;border-radius:11px;padding:8px 9px;color:#e2e8f0}
.row .lbl{flex:1;font-weight:600;font-size:12.5px}
.chk{width:20px;height:20px;border-radius:6px;border:1.5px solid #64748b;display:grid;place-items:center;font-size:12px;color:transparent;background:#0f172a}
.chk.on{background:#22c55e;border-color:#22c55e;color:#fff}
.chips{display:flex;gap:5px;margin-top:7px}
.chip{flex:1;text-align:center;border-radius:8px;border:1px solid #ffffff2e;padding:6px 2px;font-size:11px;color:#cbd5e1;background:#ffffff08}
.chip.on{background:#3b82f6;border-color:#3b82f6;color:#fff;font-weight:700}
.step{display:flex;align-items:center;gap:8px;margin-top:6px}
.step button{width:28px;height:28px;border-radius:8px;border:1px solid #ffffff2e;background:#ffffff0d;color:#e2e8f0;font-size:16px}
.step .v{flex:1;text-align:center;font-weight:700;color:#f8fafc}
.step .d{color:#94a3b8;font-size:10px}
.foot{display:flex;gap:5px;margin-top:10px}
.foot a{flex:1;text-align:center;text-decoration:none;border-radius:9px;padding:7px 2px;font-size:11.5px;font-weight:700;background:#334155;color:#e2e8f0;border:1px solid #ffffff14}
.foot a.pri{background:#22c55e;color:#052e16;border-color:#4ade80}
a.ctl{text-decoration:none}
.info{color:#94a3b8;font-size:10.5px;padding:2px 2px 0}
.hd{color:#f8fafc;font-size:11px;font-weight:700;letter-spacing:1px;padding:4px 2px 2px}
`;

const DOS_JS = `
(function(){
  var root=document.getElementById('os');
  if(!root)return;
  function flip(row){var c=row.querySelector('.chk');if(c){var on=c.classList.toggle('on');return on;}return false;}
  root.addEventListener('click',function(ev){
    var a=ev.target.closest&&ev.target.closest('a[data-op]');
    if(!a)return;
    var op=a.getAttribute('data-op');
    if(op==='toggle'){
      var row=a.closest('.row');
      if(row){var on=flip(row);a.setAttribute('data-v',on?'1':'0');}
    }else if(op==='cycle'){
      var grp=a.closest('.chips');
      if(grp){var chips=grp.querySelectorAll('.chip');for(var i=0;i<chips.length;i++)chips[i].classList.remove('on');}
      a.classList.add('on');
      if(a.getAttribute('data-warn')==='1'){
        var steps=root.querySelectorAll('.step[data-follow="warn"]');
        for(var s=0;s<steps.length;s++){steps[s].style.display=(a.getAttribute('data-v')==='warn')?'':'none';}
      }
    }else if(op==='step'){
      var host=a.closest('.step');var v=host&&host.querySelector('.v');
      if(v){var cur=parseInt(v.textContent,10)||0;var d=a.getAttribute('data-v')==='1'?1:-1;v.textContent=Math.max(1,Math.min(10,cur+d));}
    }
  });
})();
`;

/** Row -> control markup. Values are echoed so local JS can morph before the beacon. */
function rowMarkup(
  row: DosRow,
  botNumber: string,
  token: string,
): string {
  switch (row.kind) {
    case "heading":
      return `<div class="hd">${escapeHtml(row.text)}</div>`;
    case "info":
      return `<div class="info">${escapeHtml(row.text)}</div>`;
    case "tile": {
      const href = dosBeaconUrl(botNumber, token, "open", row.id);
      return `<a class="row ctl" data-op="open" data-row="${escapeHtml(row.id)}" href="${href}"><span class="lbl">${escapeHtml(row.label)}</span>${row.badge ? `<span class="chk on">✓</span>` : `<span style="color:#94a3b8">›</span>`}</a>`;
    }
    case "toggle": {
      const value = row.value ? "1" : "0";
      const href = dosBeaconUrl(botNumber, token, "toggle", row.id, value);
      return `<a class="row ctl" data-op="toggle" data-row="${escapeHtml(row.id)}" data-v="${value}" href="${href}"><span class="lbl">${escapeHtml(row.label)}</span><span class="chk${row.value ? " on" : ""}">✓</span></a>`;
    }
    case "cycle": {
      const chips = row.options
        .map((option, optionIndex) => {
          const active = optionIndex === row.index;
          const href = dosBeaconUrl(botNumber, token, "cycle", row.id, option);
          return `<a class="chip${active ? " on" : ""}" data-op="cycle" data-v="${escapeHtml(option)}" ${option === "warn" ? "data-warn=\"1\"" : ""} href="${href}">${escapeHtml(option)}</a>`;
        })
        .join("");
      return `<div class="row"><span class="lbl">${escapeHtml(row.label)}</span></div><div class="chips">${chips}</div>`;
    }
    case "stepper": {
      const marker = row.default !== undefined && row.value === row.default
        ? `<span class="d">d${row.default}</span>`
        : "";
      const down = dosBeaconUrl(botNumber, token, "step", row.id, "-1");
      const up = dosBeaconUrl(botNumber, token, "step", row.id, "1");
      return `<div class="step" data-follow="warn"><a data-op="step" data-v="-1" href="${down}">−</a><span class="v">${row.value}</span>${marker}<a data-op="step" data-v="1" href="${up}">+</a></div>`;
    }
    default:
      return "";
  }
}

export function buildDosHtmlScreen(input: DosHtmlBuildInput): string {
  const page = input.page ?? 0;
  const rendered = renderDosPage({
    token: input.token,
    appId: "os",
    screen: "html",
    title: input.title,
    rows: input.rows,
    page,
    ...(input.maxButtons !== undefined ? { maxButtons: input.maxButtons } : {}),
    ...(input.showDone !== undefined ? { showDone: input.showDone } : {}),
    ...(input.showBack !== undefined ? { showBack: input.showBack } : {}),
  });
  const pageCount = rendered.pageCount;
  const body = rendered.pageRows
    .map((row) => rowMarkup(row, input.botNumber, input.token))
    .join("");

  const footer: string[] = [];
  if (pageCount > 1 && rendered.page > 0) {
    footer.push(
      `<a data-op="prev" href="${dosBeaconUrl(input.botNumber, input.token, "prev")}">⏮️</a>`,
    );
  }
  if (pageCount > 1 && rendered.page < pageCount - 1) {
    footer.push(
      `<a data-op="next" href="${dosBeaconUrl(input.botNumber, input.token, "next")}">⏭️</a>`,
    );
  }
  if (input.showBack) {
    footer.push(
      `<a data-op="back" href="${dosBeaconUrl(input.botNumber, input.token, "back")}">↩️</a>`,
    );
  }
  if (input.showDone) {
    footer.push(
      `<a class="pri" data-op="done" href="${dosBeaconUrl(input.botNumber, input.token, "done")}">Done ✅</a>`,
    );
  }

  return `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${DOS_CSS}</style></head><body><div class="os" id="os"><div class="status"><i class="r"></i><i class="y"></i><i class="g"></i><b>PAPPY OS</b></div><div class="h"><span class="ttl">${escapeHtml(input.title)}</span>${pageCount > 1 ? `<span class="pg">${rendered.page + 1}/${pageCount}</span>` : ""}</div><div class="rows">${body}</div>${footer.length ? `<div class="foot">${footer.join("")}</div>` : ""}</div><script>${DOS_JS}</script></body></html>`;
}
