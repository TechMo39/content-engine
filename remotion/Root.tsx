import React from "react";
import { Composition } from "remotion";
import { TileBuild, TileBuildProps } from "./TileBuild";

// Kleine ingebouwde fixture zodat `remotion studio` meteen iets toont.
const FIXTURE_SVG = `<svg viewBox="0 0 100 70"><rect x="0" y="0" width="100" height="70" fill="#eae4d7"/>
<polygon points="10,10 20,10 15,20" fill="#c75a4e"/>
<polygon points="40,10 50,10 45,20" fill="#45497d"/>
<polygon points="70,10 80,10 75,20" fill="#e7c077"/>
<polygon points="25,35 35,35 30,45" fill="#117573"/>
<polygon points="55,35 65,35 60,45" fill="#a25662"/>
<polygon points="10,50 20,50 15,60" fill="#e4ce8c"/>
<polygon points="80,50 90,50 85,60" fill="#90a084"/></svg>`;

const defaultProps: TileBuildProps = {
  svg: FIXTURE_SVG,
  name: "Studio Vlinder",
  captions: [
    { text: "Handgemaakt, steen voor steen", fromSec: 0.3, toSec: 3.2 },
    { text: "Studio Vlinder", fromSec: 3.4, toSec: 5.6 },
    { text: "Jouw naam in zellige", fromSec: 5.8, toSec: 8.0 },
  ],
  brand: "Tale of Tiles",
  site: "taleoftiles.com",
  audioSrc: "",
  revealMode: "radial",
  revealStartSec: 0.5,
  revealEndSec: 6.6,
  popDurSec: 0.7,
  tileSelector: "polygon,path",
  namefont: "romeins",
  ink: "gold",
  textScale: 1.35,
  plateScale: 1,
  theme: "dark",
  colBg: "#1a1327",
  colBg2: "#241a3a",
  colGold: "#d6b35a",
  colCream: "#f4ecdc",
  colInkOnPlate: "#4a3a2a",
  logoSrc: "",
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="TileBuild"
      component={TileBuild}
      durationInFrames={8 * 30}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={defaultProps}
      // Laat de orchestrator formaat/duur/fps via inputProps overschrijven.
      calculateMetadata={({ props }) => {
        const anyProps = props as TileBuildProps & {
          _fps?: number;
          _width?: number;
          _height?: number;
          _durationSec?: number;
        };
        const fps = anyProps._fps ?? 30;
        return {
          fps,
          width: anyProps._width ?? 1080,
          height: anyProps._height ?? 1920,
          durationInFrames: Math.round((anyProps._durationSec ?? 8) * fps),
        };
      }}
    />
  );
};
