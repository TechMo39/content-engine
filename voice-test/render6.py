import time, soundfile as sf
import perth
class _NoWM:
    def apply_watermark(self,wav,sample_rate=None,**k): return wav
    def get_watermark(self,*a,**k): return None
perth.PerthImplicitWatermarker=_NoWM
from chatterbox.mtl_tts import ChatterboxMultilingualTTS
m=ChatterboxMultilingualTTS.from_pretrained(device="cpu")
txt="Stel je voor: een webbureau markeert een signaal, en binnen een minuut ligt die warme lead bij jou op tafel. Geen koude acquisitie meer. Alleen klanten die al klaar zijn om te kopen."
import os; os.makedirs("out", exist_ok=True)
for i in range(1,7):
    t=time.time()
    try:
        wav=m.generate(txt, language_id="nl", audio_prompt_path=f"refs/ref{i}.wav")
        sf.write(f"out/stem{i}.wav", wav.squeeze().cpu().numpy(), m.sr)
        print(f"out/stem{i}.wav klaar ({time.time()-t:.0f}s)")
    except Exception as e:
        print(f"stem{i} FOUT: {e}")
print("=== ALLE KLAAR ===")
