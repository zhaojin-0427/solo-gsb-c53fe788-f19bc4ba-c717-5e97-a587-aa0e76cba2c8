/* 保存响应归属规则的前端逻辑测试（Node 运行，DOM 以桩代替）。
 *
 * 运行：node tests/save_ownership.test.js
 *
 * 修复前：savePlan 的响应无条件回写 state.planId 与方案名称并弹提示——
 * 保存 A 尚未返回便打开 B，迟到的 A 响应会把 B 的编辑页绑到 A，
 * 后续保存随之覆盖 A。
 *
 * 修复后按“方案上下文 + 草稿变化 + 请求先后”裁决响应能否更新当前页面：
 *   1. 正常保存：绑定新 ID、回写名称、保留有效协调结果；
 *   2. 保存等待期打开另一方案：迟到成功响应不错绑、不弹提示，
 *      后续保存发往当前方案（不覆盖旧方案）；
 *   3. 保存等待期新建方案：迟到成功/失败响应均静默、不回绑；
 *   4. 保存等待期删除当前方案：迟到成功响应静默、不回绑；
 *   5. 同一方案等待期继续编辑：成功创建的 ID 仍用于后续覆盖保存，
 *      旧名称不得覆盖新草稿；
 *   6. 连续保存：较早响应不得回退较新的绑定（POST/POST 与 PUT/PUT，
 *      无论落地先后）；
 *   7. 连续保存中较早请求失败静默；当前上下文最新保存失败照常报错；
 *   8. 打开等待期（已发起未落地）保存响应即过期；等待期内发起的保存
 *      在打开落地后同样过期。
 */
"use strict";

const fs = require("fs");
const path = require("path");

// --------------------------- DOM 桩 ---------------------------

const elements = {};

function makeCtx() {
  // 画布 2D 上下文：任何方法调用都是空操作，属性可写
  return new Proxy(
    {},
    {
      get: (target, prop) => {
        if (!(prop in target)) target[prop] = () => {};
        return target[prop];
      },
      set: (target, prop, v) => {
        target[prop] = v;
        return true;
      },
    }
  );
}

function makeEl(id) {
  return {
    id,
    hidden: false,
    disabled: false,
    checked: false,
    textContent: "",
    innerHTML: "",
    value: "",
    className: "",
    style: {},
    clientWidth: 1100,
    width: 1100,
    height: 320,
    addEventListener() {},
    querySelector(sel) {
      return makeEl(id + " " + sel);
    },
    querySelectorAll() {
      return [makeEl(id + "/q1"), makeEl(id + "/q2")];
    },
    appendChild() {},
    scrollIntoView() {},
    getContext() {
      return makeCtx();
    },
  };
}

global.document = {
  querySelector(sel) {
    if (!elements[sel]) elements[sel] = makeEl(sel);
    return elements[sel];
  },
  createElement: (tag) => makeEl("<" + tag + ">"),
  addEventListener() {},
  body: { appendChild() {} },
};
global.window = { devicePixelRatio: 1, addEventListener() {} };
global.confirm = () => true;

// 可控 fetch：被测代码内 fetch(...) 解析到全局，驱动用 __fetchImpl 换实现
globalThis.__fetchImpl = () => Promise.reject(new Error("fetch 未 mock"));
global.fetch = (...args) => globalThis.__fetchImpl(...args);

globalThis.__deferred = () => {
  let resolve, reject;
  const p = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { p, resolve, reject };
};

// --------------------------- 加载被测代码并驱动 ---------------------------

const src = fs.readFileSync(
  path.join(__dirname, "..", "app", "static", "app.js"),
  "utf8"
);

// 驱动代码与被测代码同一 eval 作用域，可直接访问其顶层绑定
// （state / plan / savePlan / loadPlan / deletePlan / newPlan /
//   solvePlan / onPlanEdited ...）
const driver = `
;(async function __drive__() {
  const results = [];
  const t = (name, cond) => {
    results.push([name, !!cond]);
    console.log((cond ? "PASS" : "FAIL") + "  " + name);
  };
  const $el = (sel) => document.querySelector(sel);
  const okJson = (data) => Promise.resolve({ ok: true, json: async () => data });
  const VALID_MICS = [
    { id: "A", candidates: [520, 540], current: null, locked: false },
    { id: "B", candidates: [525, 545], current: null, locked: false },
  ];
  const SOLVE_OK = {
    status: "optimal", optimal: true, assignedCount: 2, changeCount: 0,
    solveTimeMs: 5, timeLimitSec: 10, phases: [],
    assignment: [
      { id: "A", locked: false, current: null, assigned: true, frequency: 520, changed: false },
      { id: "B", locked: false, current: null, assigned: true, frequency: 545, changed: false },
    ],
    conflicts: [],
  };
  const setValidPlan = (name) => {
    $el("#planName").value = name;
    $el("#minGap").value = "5";
    $el("#imTolerance").value = "0";
    $el("#timeLimit").value = "10";
    plan.forbidden = [];
    plan.mics = VALID_MICS.map((m) => ({ ...m, candidates: [...m.candidates] }));
  };
  const PLAN_REC = (id, name, mics) => ({
    id, name,
    plan: { name, minGap: 5, imTolerance: 0, timeLimit: 10, forbidden: [], mics },
  });
  const MICS_OF = (a, b) => [
    { id: a, candidates: [600, 610], current: null, locked: false },
    { id: b, candidates: [620, 630], current: null, locked: false },
  ];

  // 1. 正常保存（新建）：绑定 ID、回写名称、保留有效协调结果
  newPlan(false);
  setValidPlan("正常保存");
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/solve") return okJson(SOLVE_OK);
    if (url === "/api/plans" && opts && opts.method === "POST") {
      return okJson({ id: 5, name: "正常保存" });
    }
    return Promise.reject(new Error("unexpected " + url));
  };
  await solvePlan();
  t("前置：求解结果上屏", state.result !== null);
  await savePlan();
  t("正常保存：绑定新方案 ID 并回写名称",
    state.planId === 5 && $el("#planName").value === "正常保存");
  t("正常保存：保留有效协调结果",
    state.result !== null && $el("#resultPanel").hidden === false);
  t("正常保存：弹出成功提示", $el("#toast").textContent.includes("已保存"));

  // 2. 保存等待期打开另一方案：迟到成功响应不错绑，后续保存发往当前方案
  $el("#planName").value = "方案甲改";
  const dSave2 = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans/5" && opts && opts.method === "PUT") return dSave2.p;
    if (url === "/api/plans/9") {
      return okJson(PLAN_REC(9, "方案乙", MICS_OF("C", "D")));
    }
    return Promise.reject(new Error("unexpected " + url));
  };
  const pSave2 = savePlan();   // PUT /api/plans/5，在途
  await loadPlan(9);            // 打开方案乙并落地
  t("打开落地：当前页绑定方案乙",
    state.planId === 9 && plan.name === "方案乙");
  const toastBefore2 = $el("#toast").textContent;
  dSave2.resolve({ ok: true, json: async () => ({ id: 5, name: "方案甲改" }) });
  await pSave2;
  t("迟到的保存成功响应：不把当前页绑回旧方案",
    state.planId === 9 && plan.name === "方案乙" &&
    $el("#planName").value === "方案乙");
  t("迟到的保存成功响应：不弹提示（仅保留服务端保存结果）",
    $el("#toast").textContent === toastBefore2);
  let next2 = null;
  globalThis.__fetchImpl = (url, opts) => {
    next2 = { url, method: opts && opts.method };
    return okJson({ id: 9, name: "方案乙" });
  };
  await savePlan();
  t("后续保存发往当前方案（PUT /9，不覆盖旧方案）",
    next2 && next2.url === "/api/plans/9" && next2.method === "PUT");

  // 3. 保存等待期新建方案：迟到成功/失败响应均静默、不回绑
  const dSave3 = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans/9" && opts && opts.method === "PUT") return dSave3.p;
    return Promise.reject(new Error("unexpected " + url));
  };
  const pSave3 = savePlan();   // PUT /api/plans/9，在途
  newPlan(false);               // 新建：上下文切换，planId 归零
  t("新建后：planId 已清空", state.planId === null);
  const toastBefore3 = $el("#toast").textContent;
  dSave3.resolve({ ok: true, json: async () => ({ id: 9, name: "方案乙" }) });
  await pSave3;
  t("新建后迟到的保存成功响应：不回绑、不弹提示",
    state.planId === null && $el("#toast").textContent === toastBefore3);
  setValidPlan("临建方案");
  const dSave3b = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && opts && opts.method === "POST") return dSave3b.p;
    return Promise.reject(new Error("unexpected " + url));
  };
  const pSave3b = savePlan();  // POST 在途
  newPlan(false);               // 再次新建：上下文切换
  const toastBefore3b = $el("#toast").textContent;
  dSave3b.reject(new Error("网络错误"));
  await pSave3b;
  t("新建后迟到的保存失败响应：不对当前页报错、不回绑",
    state.planId === null &&
    $el("#toast").textContent === toastBefore3b &&
    !$el("#toast").textContent.includes("保存失败"));

  // 4. 保存等待期删除当前方案：迟到成功响应静默、不回绑
  globalThis.__fetchImpl = (url) => {
    if (url === "/api/plans/12") {
      return okJson(PLAN_REC(12, "方案丙", MICS_OF("E", "F")));
    }
    return Promise.reject(new Error("unexpected " + url));
  };
  await loadPlan(12);
  const dSave4 = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans/12" && opts && opts.method === "PUT") return dSave4.p;
    if (url === "/api/plans/12" && opts && opts.method === "DELETE") {
      return okJson({ ok: true });
    }
    if (url === "/api/plans") return okJson([]); // renderPlanMenu
    return Promise.reject(new Error("unexpected " + url));
  };
  const pSave4 = savePlan();   // PUT /api/plans/12，在途
  await deletePlan(12);         // 删除当前方案 → 回到新建状态
  t("删除当前方案后：回到新建状态", state.planId === null);
  const toastBefore4 = $el("#toast").textContent; // “方案已删除”
  dSave4.resolve({ ok: true, json: async () => ({ id: 12, name: "方案丙" }) });
  await pSave4;
  t("删除后迟到的保存成功响应：不回绑、不弹提示",
    state.planId === null && $el("#toast").textContent === toastBefore4);

  // 5. 同一方案等待期继续编辑：成功创建的 ID 仍绑定，旧名称不覆盖新草稿
  newPlan(false);
  setValidPlan("原名");
  const dSave5 = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && opts && opts.method === "POST") return dSave5.p;
    return Promise.reject(new Error("unexpected " + url));
  };
  const pSave5 = savePlan();   // POST 在途（创建）
  plan.mics[0].candidates = [531, 551]; // 等待期继续编辑候选频点
  onPlanEdited();
  $el("#planName").value = "新名";      // 等待期修改名称草稿
  dSave5.resolve({ ok: true, json: async () => ({ id: 21, name: "原名" }) });
  await pSave5;
  t("等待期继续编辑：成功创建的 ID 仍绑定（用于后续覆盖保存）",
    state.planId === 21);
  t("等待期继续编辑：旧名称不得覆盖新草稿",
    $el("#planName").value === "新名");
  let next5 = null;
  globalThis.__fetchImpl = (url, opts) => {
    next5 = { url, method: opts && opts.method, body: opts && opts.body };
    return okJson({ id: 21, name: "新名" });
  };
  await savePlan();
  t("后续保存为覆盖保存（PUT 到已创建 ID），提交新草稿",
    next5 && next5.url === "/api/plans/21" && next5.method === "PUT" &&
    next5.body.includes("新名") && next5.body.includes("531"));
  t("名称未再改动：回写服务端规整名", $el("#planName").value === "新名");

  // 6a. 连续保存（POST/POST），较新响应先落地：较早响应不得回退
  newPlan(false);
  setValidPlan("版本一");
  const dA = __deferred();
  const dB = __deferred();
  let postCount = 0;
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && opts && opts.method === "POST") {
      postCount++;
      return postCount === 1 ? dA.p : dB.p;
    }
    return Promise.reject(new Error("unexpected " + url));
  };
  const pA = savePlan();             // 第一次保存（POST，在途）
  $el("#planName").value = "版本二";
  const pB = savePlan();             // 紧接着第二次保存（POST，在途）
  dB.resolve({ ok: true, json: async () => ({ id: 31, name: "版本二" }) });
  await pB;
  t("连续保存：较新响应先落地并绑定", state.planId === 31);
  dA.resolve({ ok: true, json: async () => ({ id: 30, name: "版本一" }) });
  await pA;
  t("连续保存：较早响应不得回退较新的绑定",
    state.planId === 31 && $el("#planName").value === "版本二");

  // 6b. 连续保存（POST/POST），较旧响应先落地：按序绑定，旧名不盖新草稿
  newPlan(false);
  setValidPlan("甲版");
  const dC = __deferred();
  const dD = __deferred();
  postCount = 0;
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && opts && opts.method === "POST") {
      postCount++;
      return postCount === 1 ? dC.p : dD.p;
    }
    return Promise.reject(new Error("unexpected " + url));
  };
  const pC = savePlan();
  $el("#planName").value = "乙版";
  const pD = savePlan();
  dC.resolve({ ok: true, json: async () => ({ id: 40, name: "甲版" }) });
  await pC;
  t("连续保存：较旧响应先落地时按序绑定", state.planId === 40);
  t("较旧响应落地：旧名称不覆盖等待期的新草稿",
    $el("#planName").value === "乙版");
  dD.resolve({ ok: true, json: async () => ({ id: 41, name: "乙版" }) });
  await pD;
  t("连续保存：较新响应后落地仍生效",
    state.planId === 41 && $el("#planName").value === "乙版");

  // 6c. 连续覆盖保存（PUT/PUT），较旧响应后落地：不得回退名称绑定
  $el("#planName").value = "丙版";
  const dE = __deferred();
  const dF = __deferred();
  let putCount = 0;
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans/41" && opts && opts.method === "PUT") {
      putCount++;
      return putCount === 1 ? dE.p : dF.p;
    }
    return Promise.reject(new Error("unexpected " + url));
  };
  const pE = savePlan();
  $el("#planName").value = "丁版";
  const pF = savePlan();
  dF.resolve({ ok: true, json: async () => ({ id: 41, name: "丁版" }) });
  await pF;
  dE.resolve({ ok: true, json: async () => ({ id: 41, name: "丙版" }) });
  await pE;
  t("连续覆盖保存：较早响应不得回退较新的名称绑定",
    state.planId === 41 && $el("#planName").value === "丁版");

  // 7. 连续保存中较早请求失败静默；当前上下文最新保存失败照常报错
  newPlan(false);
  setValidPlan("失败序");
  const dG = __deferred();
  const dH = __deferred();
  postCount = 0;
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && opts && opts.method === "POST") {
      postCount++;
      return postCount === 1 ? dG.p : dH.p;
    }
    return Promise.reject(new Error("unexpected " + url));
  };
  const pG = savePlan();
  const pH = savePlan();
  const toastBefore7 = $el("#toast").textContent;
  dG.reject(new Error("网络错误"));
  await pG;
  t("连续保存：较早请求失败静默（成败由较新请求报告）",
    $el("#toast").textContent === toastBefore7);
  dH.resolve({ ok: true, json: async () => ({ id: 50, name: "失败序" }) });
  await pH;
  t("连续保存：较新请求成功照常绑定并提示",
    state.planId === 50 && $el("#toast").textContent.includes("已保存"));
  const dI = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans/50" && opts && opts.method === "PUT") return dI.p;
    return Promise.reject(new Error("unexpected " + url));
  };
  const pI = savePlan();
  dI.resolve({ ok: false, status: 500, json: async () => ({ detail: "服务器错误" }) });
  await pI;
  t("当前方案保存失败：照常报错",
    $el("#toast").textContent.includes("保存失败"));

  // 8a. 打开等待期（已发起未落地）：保存响应即过期
  newPlan(false);
  setValidPlan("方案戊");
  const dSave8 = __deferred();
  const dGet8 = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && opts && opts.method === "POST") return dSave8.p;
    if (url === "/api/plans/60") return dGet8.p;
    return Promise.reject(new Error("unexpected " + url));
  };
  const pSave8 = savePlan();     // POST 在途
  const pLoad8 = loadPlan(60);   // 打开发起（GET 在途）——上下文已切换
  const toastBefore8 = $el("#toast").textContent;
  dSave8.resolve({ ok: true, json: async () => ({ id: 55, name: "方案戊" }) });
  await pSave8;
  t("打开等待期：迟到保存成功响应不绑定、不提示",
    state.planId === null && $el("#toast").textContent === toastBefore8);
  dGet8.resolve({
    ok: true,
    json: async () => PLAN_REC(60, "方案己", MICS_OF("G", "H")),
  });
  await pLoad8;
  t("打开落地：绑定新方案", state.planId === 60 && plan.name === "方案己");

  // 8b. 打开等待期内发起的保存：打开落地后响应同样过期
  const dSave8b = __deferred();
  const dGet8b = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans/60" && opts && opts.method === "PUT") return dSave8b.p;
    if (url === "/api/plans/61") return dGet8b.p;
    return Promise.reject(new Error("unexpected " + url));
  };
  const pLoad8b = loadPlan(61);  // 打开发起：上下文切换（GET 在途）
  const pSave8b = savePlan();    // 等待期内发起保存（旧表单内容，PUT /60）
  dGet8b.resolve({
    ok: true,
    json: async () => PLAN_REC(61, "方案庚", MICS_OF("I", "J")),
  });
  await pLoad8b;                  // 打开落地：再次切换上下文
  t("打开落地：切换到方案庚", state.planId === 61 && plan.name === "方案庚");
  const toastBefore8b = $el("#toast").textContent;
  dSave8b.resolve({ ok: true, json: async () => ({ id: 60, name: "方案己" }) });
  await pSave8b;
  t("等待期发起的保存：落地后迟到响应不得绑定新方案",
    state.planId === 61 && plan.name === "方案庚" &&
    $el("#toast").textContent === toastBefore8b);

  const failed = results.filter(([, ok]) => !ok).length;
  console.log("\\n" + (results.length - failed) + "/" + results.length + " 通过");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("驱动异常：", e);
  process.exit(1);
});
`;

try {
  // eslint-disable-next-line no-eval
  eval(src + "\n" + driver);
} catch (e) {
  console.error("加载被测代码失败：", e);
  process.exit(1);
}
