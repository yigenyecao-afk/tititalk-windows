// Wave 4 Stage 2 — 分享卡片 PNG 渲染。
//
// 1080×720 横版，Spotify-Wrapped 风格：
//   • 顶部：宠物 emoji + 名字 + tagline
//   • 主区：3 个数据 metric（今日字数 / 节省时间 / 连续天数）
//   • 底部：tititalk.com 水印 + slug 副 logo
//
// 不依赖 html2canvas / dom-to-image —— 直接 Canvas 2D drawImage / fillText。
// 字体走系统默认（中文 PingFang/MSYH 自动 fallback）。
//
// 输出：base64 PNG 字符串（不带 "data:image/png;base64," 前缀），交给
// Rust cmd_companion_save_share_card 写盘。

import type { PetMeta } from "./types";

export interface ShareCardData {
  pet: PetMeta;
  petName: string;       // 用户自定义名（可能跟 pet.name 不同）
  dayChars: number;
  savedMinutes: number;
  streakDays: number;
  skillLvl: number;
}

const W = 1080;
const H = 720;

export async function renderShareCard(data: ShareCardData): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");

  // 背景：vibe 渐变
  const bg = ctx.createLinearGradient(0, 0, W, H);
  const [c1, c2] = vibeColors(data.pet.vibe);
  bg.addColorStop(0, c1);
  bg.addColorStop(1, c2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 半透明圆点纹理（轻装饰）
  ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
  for (let i = 0; i < 60; i++) {
    const r = 6 + Math.random() * 18;
    ctx.beginPath();
    ctx.arc(Math.random() * W, Math.random() * H, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 左上角 eyebrow + 标题（编辑器风格）
  ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
  ctx.font = "16px ui-monospace, 'SF Mono', Cascadia Code, Consolas, monospace";
  ctx.fillText("TITITALK · 桌面陪伴", 64, 80);

  ctx.fillStyle = "white";
  ctx.font = "bold 56px -apple-system, BlinkMacSystemFont, 'Microsoft YaHei', sans-serif";
  ctx.fillText("我的 " + data.petName, 64, 144);

  // tagline
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.font = "20px -apple-system, BlinkMacSystemFont, 'Microsoft YaHei', sans-serif";
  ctx.fillText(data.pet.tagline, 64, 184);

  // 宠物 emoji（中央偏右）
  ctx.font = "320px sans-serif"; // emoji 跟随系统 emoji font
  ctx.textBaseline = "middle";
  ctx.fillText(data.pet.emoji, W - 360, H / 2 + 30);

  // 3 项 metric 卡 — 左中下
  const metrics = [
    { label: "今日字数", value: data.dayChars.toLocaleString("zh-CN"), unit: "字" },
    { label: "节省时间", value: data.savedMinutes.toFixed(1), unit: "分钟" },
    { label: "连续天数", value: String(data.streakDays), unit: "天" },
  ];
  ctx.textBaseline = "alphabetic";
  metrics.forEach((m, i) => {
    const x = 64;
    const y = 320 + i * 120;
    ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
    ctx.font = "14px ui-monospace, monospace";
    ctx.fillText(m.label.toUpperCase(), x, y - 6);

    ctx.fillStyle = "white";
    ctx.font = "bold 64px -apple-system, BlinkMacSystemFont, 'Microsoft YaHei', sans-serif";
    ctx.fillText(m.value, x, y + 56);

    ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
    ctx.font = "22px -apple-system, BlinkMacSystemFont, 'Microsoft YaHei', sans-serif";
    const valW = ctx.measureText(m.value).width;
    ctx.fillText(" " + m.unit, x + valW + 8, y + 56);
  });

  // 等级 chip 顶部右
  ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
  roundRect(ctx, W - 220, 56, 156, 40, 20);
  ctx.fill();
  ctx.fillStyle = "white";
  ctx.font = "bold 18px ui-monospace, monospace";
  ctx.fillText("Lv. " + data.skillLvl + " · " + data.pet.vibe, W - 200, 82);

  // 底部 footer：tititalk.com + 日期
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.font = "16px ui-monospace, monospace";
  ctx.fillText("tititalk.com · " + new Date().toISOString().slice(0, 10), 64, H - 48);

  // toDataURL → strip prefix
  const dataUrl = canvas.toDataURL("image/png");
  return dataUrl.replace(/^data:image\/png;base64,/, "");
}

function vibeColors(v: string): [string, string] {
  switch (v) {
    case "cozy":     return ["#FB923C", "#9D4EDD"];
    case "focused":  return ["#0EA5E9", "#1E1B4B"];
    case "playful":  return ["#F472B6", "#7C3AED"];
    case "heroic":   return ["#DC2626", "#0F172A"];
    case "cheerful": return ["#FCD34D", "#F97316"];
    default:         return ["#FB923C", "#9D4EDD"];
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
