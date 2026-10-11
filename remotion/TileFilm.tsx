import React, { useMemo } from "react";
import {
  AbsoluteFill,
  Img,
  Audio,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from "remotion";
import { parseTiles, colorsAt, buildSvg, Storyboard } from "./film";

export type TileFilmProps = {
  svg: string;
  storyboard: Storyboard;
  brand: string;
  site: string;
  audioSrc: string;
  logoSrc: string;
  colBg: string;
  colBg2: string;
  colGold: string;
  colCream: string;
};

export const TileFilm: React.FC<TileFilmProps> = ({
  svg, storyboard, brand, site, audioSrc, logoSrc, colBg, colBg2, colGold, colCream,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const parsed = useMemo(() => parseTiles(svg), [svg]);
  const frameSvg = useMemo(
    () => buildSvg(parsed, colorsAt(parsed, storyboard, frame / fps)),
    [parsed, storyboard, frame, fps]
  );

  const aspect = parsed.view[2] / parsed.view[3] || 1.4;
  const panelW = Math.round(width * 0.84);
  const panelH = Math.round(panelW / aspect);
  const logoOpacity = interpolate(frame, [4, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ background: `radial-gradient(120% 90% at 50% 26%, ${colBg2} 0%, ${colBg} 70%)`, fontFamily: "Georgia, serif" }}>
      {audioSrc ? <Audio src={staticFile(audioSrc)} /> : null}

      <div style={{ position: "absolute", top: height * 0.055, width: "100%", display: "flex", justifyContent: "center", opacity: logoOpacity }}>
        {logoSrc ? (
          <Img src={logoSrc} style={{ height: height * 0.07, objectFit: "contain" }} />
        ) : (
          <div style={{ color: colGold, letterSpacing: 8, fontSize: 34, textTransform: "uppercase" }}>{brand}</div>
        )}
      </div>

      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", top: -height * 0.04 }}>
        <div
          style={{
            width: panelW, height: panelH, padding: 16,
            background: "linear-gradient(145deg,#2a2335,#0e0a16)",
            border: `2px solid ${colGold}`, borderRadius: 6,
            boxShadow: "0 40px 90px rgba(0,0,0,0.45), 0 8px 22px rgba(0,0,0,0.3)",
          }}
        >
          <div
            style={{ width: "100%", height: "100%", overflow: "hidden" }}
            dangerouslySetInnerHTML={{ __html: frameSvg.replace(/<svg\b/i, '<svg style="width:100%;height:100%;display:block" ') }}
          />
        </div>
      </AbsoluteFill>

      <div style={{ position: "absolute", bottom: height * 0.07, width: "100%", textAlign: "center", color: colGold, fontSize: 36, letterSpacing: 2 }}>
        {site}
      </div>
    </AbsoluteFill>
  );
};
