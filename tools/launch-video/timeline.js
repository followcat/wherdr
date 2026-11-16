/* The v3 story, from real demo captures: Home, Alfred, a coordinator's plan,
   Tasks to review, the Board moving, then the same session on a phone. */
const wide = document.getElementById("film").classList.contains("wide");
const length = Number(document.getElementById("film").dataset.duration);
const tl = gsap.timeline({ paused: true, defaults: { ease: "power2.inOut" } });
const titleIn = (id, at) =>
  tl.fromTo(id, { y: 25, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.35 }, at);
const titleOut = (id, at) =>
  tl.to(id, { y: -20, autoAlpha: 0, duration: 0.25 }, at);
const show = (id, at, duration = 0.3) =>
  tl.to(id, { autoAlpha: 1, duration }, at);
// Slowly zoom into one area of the desktop capture, then back out.
const zoom = (origin, scale, from, to) => {
  tl.set("#zoom", { transformOrigin: origin }, from);
  tl.to("#zoom", { scale, duration: to - from - 0.6, ease: "power1.inOut" }, from);
  tl.to("#zoom", { scale: 1, duration: 0.5 }, to - 0.5);
};
const flash = (id, at) => {
  show(id, at, 0.2);
  tl.to(id, { autoAlpha: 0, duration: 0.2 }, at + 0.7);
};

// Open wherdr on a computer.
titleIn("#home-title", 0);
tl.fromTo(
  "#desktop",
  { y: 65, scale: 0.94, rotation: -1, autoAlpha: 0 },
  { y: 0, scale: 1, rotation: 0, autoAlpha: 1, duration: 0.65 },
  0,
);
tl.to("#desktop", { scale: 1.03, duration: 3.5 }, 0.65);
// Alfred says what waits.
titleOut("#home-title", 4.3);
titleIn("#alfred-title", 4.6);
show("#alfred", 4.6);
zoom("62% 40%", 1.3, 5, 9.3);
tl.to("#desktop", { scale: 1, duration: 0.5 }, 4.6);
// The project's coordinator proposes the plan and starts the tasks.
titleOut("#alfred-title", 9);
titleIn("#coord-title", 9.3);
show("#coord", 9.3);
zoom("64% 50%", 1.3, 9.7, 14.3);
// Tasks to review: screenshots, then Approve.
titleOut("#coord-title", 14);
titleIn("#review-title", 14.3);
show("#review", 14.3);
zoom("40% 85%", 1.25, 14.7, 19.7);
flash("#approve-glow", 16.9);
show("#approved", 17.5, 0.12);
// The Board: WEB-7 moves to Done.
titleOut("#review-title", 19.4);
titleIn("#board-title", 19.7);
show("#board", 19.7);
show("#board-after", 21.7, 0.6);
flash("#done-glow", 22.5);
// The same session, now on a phone.
titleOut("#board-title", 24.2);
tl.to(
  "#desktop",
  { x: wide ? -240 : -160, y: 30, scale: 0.72, autoAlpha: 0, duration: 0.7 },
  24.4,
);
tl.fromTo(
  "#phone",
  { x: wide ? -250 : -240, y: 170, scale: 0.65, rotation: 5 },
  { x: 0, y: 0, scale: 1, rotation: 0, autoAlpha: 1, duration: 0.75 },
  24.4,
);
titleIn("#phone-title", 24.5);
show("#handoff", 24.8);
// An agent's question, answered with one tap.
titleOut("#phone-title,#handoff", 27.4);
titleIn("#answer-title", 27.7);
show("#question", 27.6, 0.25);
flash("#answer-glow", 29.2);
show("#answered", 29.8, 0.12);
tl.to("#phone", { y: -13, scale: 1.018, duration: 1.2 }, 29.8);
// End card.
show("#end", 32.4, 0.35);
tl.fromTo("#end h1", { y: 35 }, { y: 0, duration: 0.5 }, 32.45);
tl.fromTo(
  "#end .cta",
  { y: 20, autoAlpha: 0 },
  { y: 0, autoAlpha: 1, duration: 0.45 },
  32.7,
);
tl.to(".timeline i", { scaleX: 1, duration: length, ease: "none" }, 0);
