import { useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  opacity: number;
  color: string;
}

export const ParticleCanvas = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    // Respect user motion preferences — render a single static frame and stop.
    const reducedMotion = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    // Scale particle count by viewport area + device pixel ratio so weak
    // devices / small screens don't churn through O(n²) link calculations.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const area = window.innerWidth * window.innerHeight;
    const PARTICLE_COUNT = Math.max(18, Math.min(36, Math.round(area / 38000)));
    const LINK_DIST = 140;
    const LINK_DIST_SQ = LINK_DIST * LINK_DIST;
    const TARGET_FPS = 30;            // 30fps is plenty for ambient bg
    const FRAME_INTERVAL = 1000 / TARGET_FPS;

    let animId: number;
    let lastFrame = 0;
    let visible = true;
    let particles: Particle[] = [];

    const resize = () => {
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const colors = [
      "185, 100%, 50%",  // cyan
      "300, 100%, 45%",  // magenta
      "185, 80%, 60%",   // light cyan
      "260, 80%, 55%",   // purple
    ];

    // Initialize particles
    const W = window.innerWidth;
    const H = window.innerHeight;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        size: Math.random() * 2 + 0.5,
        opacity: Math.random() * 0.4 + 0.1,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }

    const renderFrame = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);

      particles.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.color}, ${p.opacity})`;
        ctx.fill();
      });

      // Connection lines — single stroke style, squared-distance check (no sqrt),
      // batch into one beginPath/stroke call.
      ctx.lineWidth = 0.5;
      ctx.strokeStyle = "hsla(185, 100%, 50%, 0.08)";
      ctx.beginPath();
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < LINK_DIST_SQ) {
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
          }
        }
      }
      ctx.stroke();
    };

    const animate = (ts: number) => {
      animId = requestAnimationFrame(animate);
      if (!visible) return;
      if (ts - lastFrame < FRAME_INTERVAL) return;
      lastFrame = ts;
      renderFrame();
    };

    if (reducedMotion) {
      renderFrame(); // single static frame
    } else {
      animId = requestAnimationFrame(animate);
    }

    const onVisibility = () => { visible = !document.hidden; };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 z-0"
      style={{ pointerEvents: "none" }}
    />
  );
};
