import React, { useMemo } from "react";
import {
  AbsoluteFill,
  Img,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Audio,
  staticFile,
  Easing,
} from "remotion";
import {
  parseSvg,
  orderTiles,
  buildFrameSvg,
  RevealMode,
} from "./svg";

export type Caption = { text: string; fromSec: number; toSec: number };

export type TileBuildProps = {
  svg: string;
  name: string;
  captions: Caption[];
  brand: string;
  site: string;
  audioSrc: string; // bestandsnaam in public/ ; "" = geen muziek
  // reveal
  revealMode: RevealMode;
  revealStartSec: number;
  revealEndSec: number;
  popDurSec: number;
  tileSelector: string;
  // naamplaat (zoals op de site): verschijnt als het mozaiek bijna af is
  namefont: string; // romeins | grieks | serif | ...
  ink: string; // gold | terra | ...
  textScale: number;
  plateScale: number;
  // branding
  theme: string; // "dark" (plum) | "light" (beige)
  colBg: string;
  colBg2: string;
  colGold: string;
  colCream: string;
  colInkOnPlate: string;
  logoSrc: string; // bestandsnaam in public/ ; "" = geen logo
};

const INK_HEX: Record<string, string> = {
  gold: "#b2894c",
  terra: "#b2674e",
};
const FONT_STACK: Record<string, string> = {
  romeins: "'Trajan Pro', Georgia, 'Times New Roman', serif",
  grieks: "'Optima', 'Palatino Linotype', Georgia, serif",
  serif: "Georgia, 'Times New Roman', serif",
};

export const TileBuild: React.FC<TileBuildProps> = ({
  svg,
  name,
  captions,
  brand,
  site,
  audioSrc,
  revealMode,
  revealStartSec,
  revealEndSec,
  popDurSec,
  tileSelector,
  namefont,
  ink,
  textScale,
  plateScale,
  theme,
  colBg,
  colBg2,
  colGold,
  colCream,
  colInkOnPlate,
  logoSrc,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const parsed = useMemo(() => {
    const p = parseSvg(svg, tileSelector);
    orderTiles(p, revealMode);
    return p;
  }, [svg, tileSelector, revealMode]);

  const frameSvg = useMemo(
    () =>
      buildFrameSvg(parsed, frame, {
        fps,
        revealStartSec,
        revealEndSec,
        popDurSec,
        mode: revealMode,
      }),
    [parsed, frame, fps, revealStartSec, revealEndSec, popDurSec, revealMode]
  );

  // Paneel-afmetingen: behoud aspect van het ontwerp.
  const aspect = parsed.view.w / parsed.view.h || 1.4;
  const panelW = Math.round(width * 0.84);
  const panelH = Math.round(panelW / aspect);

  // Zachte intro van het hele paneel.
  const introScale = interpolate(frame, [0, 18], [0.965, 1], {
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const introOpacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateRight: "clamp",
  });

  const isDark = theme !== "light";
  const INK = isDark ? colCream : "#1c1a17";
  const ACCENT = colGold;
  const bg = isDark
    ? `radial-gradient(120% 90% at 50% 26%, ${colBg2} 0%, ${colBg} 70%)`
    : `radial-gradient(120% 90% at 50% 28%, #f3efe8 0%, #e4ddd1 100%)`;

  // Logo verschijnt met een zachte fade.
  const logoOpacity = interpolate(frame, [4, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: bg,
        fontFamily: "Georgia, 'Times New Roman', serif",
      }}
    >
      {audioSrc ? <Audio src={staticFile(audioSrc)} /> : null}

      {/* Logo bovenaan (valt terug op woordmerk als er geen logo is) */}
      <div
        style={{
          position: "absolute",
          top: height * 0.055,
          width: "100%",
          display: "flex",
          justifyContent: "center",
          opacity: logoOpacity,
        }}
      >
        {logoSrc ? (
          <Img
            src={staticFile(logoSrc)}
            style={{ height: height * 0.07, objectFit: "contain" }}
          />
        ) : (
          <div
            style={{
              color: ACCENT,
              letterSpacing: 8,
              fontSize: 34,
              textTransform: "uppercase",
            }}
          >
            {brand}
          </div>
        )}
      </div>

      {/* Paneel */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          top: -height * 0.06,
        }}
      >
        <div
          style={{
            position: "relative",
            width: panelW,
            height: panelH,
            transform: `scale(${introScale})`,
            opacity: introOpacity,
            // Zwart metalen frame als basis (merk), subtiele slagschaduw.
            padding: 16,
            // Donker frame met een subtiele gouden binnenrand (merk).
            background: "linear-gradient(145deg,#2a2335,#0e0a16)",
            border: `2px solid ${colGold}`,
            borderRadius: 6,
            boxShadow:
              "0 40px 90px rgba(0,0,0,0.45), 0 8px 22px rgba(0,0,0,0.3)",
          }}
        >
          <div
            style={{ width: "100%", height: "100%", overflow: "hidden" }}
            dangerouslySetInnerHTML={{
              __html: frameSvg.replace(
                /<svg\b/i,
                '<svg style="width:100%;height:100%;display:block" '
              ),
            }}
          />
          <Nameplate
            name={name}
            namefont={namefont}
            plateEdge={colGold}
            plateInk={colInkOnPlate}
            textScale={textScale}
            plateScale={plateScale}
            panelW={panelW}
            panelH={panelH}
            frame={frame}
            fps={fps}
            appearSec={revealEndSec - 1.1}
          />
        </div>
      </AbsoluteFill>

      {/* Captions (lower third) */}
      {captions.map((c, i) => {
        const inF = c.fromSec * fps;
        const outF = c.toSec * fps;
        const vis = interpolate(
          frame,
          [inF, inF + 8, outF - 8, outF],
          [0, 1, 1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );
        const up = interpolate(frame, [inF, inF + 12], [18, 0], {
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        });
        const isName = c.text === name && name.length > 0;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              bottom: height * 0.16,
              width: "100%",
              textAlign: "center",
              opacity: vis,
              transform: `translateY(${up}px)`,
              color: INK,
              padding: "0 80px",
              boxSizing: "border-box",
            }}
          >
            <div
              style={{
                fontSize: isName ? 84 : 52,
                fontWeight: isName ? 600 : 400,
                lineHeight: 1.1,
                fontStyle: isName ? "normal" : "italic",
              }}
            >
              {c.text}
            </div>
          </div>
        );
      })}

      {/* CTA onderaan: gouden pil + site */}
      <div
        style={{
          position: "absolute",
          bottom: height * 0.07,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: height * 0.018,
        }}
      >
        <div
          style={{
            background: colGold,
            color: "#2a2010",
            fontSize: 38,
            fontWeight: 600,
            letterSpacing: 1,
            padding: "18px 46px",
            borderRadius: 999,
            boxShadow: "0 8px 22px rgba(0,0,0,0.35)",
          }}
        >
          Ontwerp jouw paneel
        </div>
        <div style={{ color: isDark ? colCream : "#6b5a3a", fontSize: 30, letterSpacing: 2, opacity: 0.85 }}>
          {site}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Naamplaat zoals op de site: cremekleurig bordje met randje in de ink-kleur,
// naam in serif-caps en een divider-streepje. Verschijnt rond het eind van de opbouw.
const Nameplate: React.FC<{
  name: string;
  namefont: string;
  plateEdge: string; // randkleur (brand goud)
  plateInk: string; // tekstkleur
  textScale: number;
  plateScale: number;
  panelW: number;
  panelH: number;
  frame: number;
  fps: number;
  appearSec: number;
}> = ({ name, namefont, plateEdge, plateInk, textScale, plateScale, panelW, panelH, frame, fps, appearSec }) => {
  if (!name) return null;
  const inkHex = plateEdge;
  const font = FONT_STACK[namefont] || FONT_STACK.serif;

  const inF = appearSec * fps;
  const op = interpolate(frame, [inF, inF + 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const sc = interpolate(frame, [inF, inF + 18], [0.92, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  const plateW = panelW * 0.5 * plateScale;
  const fontSize = panelH * 0.095 * textScale;
  const line = panelW * 0.06;

  return (
    <div
      style={{
        position: "absolute",
        inset: 14,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: op,
      }}
    >
      <div
        style={{
          transform: `scale(${sc})`,
          minWidth: plateW,
          maxWidth: panelW * 0.9,
          boxSizing: "border-box",
          whiteSpace: "nowrap",
          padding: `${panelH * 0.05}px ${panelW * 0.05}px`,
          background: "rgba(244,237,223,0.96)",
          border: `${Math.max(2, panelW * 0.004)}px solid ${inkHex}`,
          outline: `1px solid ${inkHex}`,
          outlineOffset: Math.max(2, panelW * 0.006),
          borderRadius: 4,
          textAlign: "center",
          boxShadow: "0 6px 18px rgba(0,0,0,0.22)",
        }}
      >
        <div
          style={{
            fontFamily: font,
            fontSize,
            lineHeight: 1.05,
            letterSpacing: fontSize * 0.08,
            color: plateInk,
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          {name}
        </div>
        <div
          style={{
            marginTop: fontSize * 0.35,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: line * 0.2,
          }}
        >
          <span style={{ width: line, height: 2, background: inkHex, opacity: 0.8 }} />
          <span
            style={{
              width: fontSize * 0.26,
              height: fontSize * 0.26,
              background: inkHex,
              transform: "rotate(45deg)",
            }}
          />
          <span style={{ width: line, height: 2, background: inkHex, opacity: 0.8 }} />
        </div>
      </div>
    </div>
  );
};
