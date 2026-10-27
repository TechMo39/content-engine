@echo off
REM content_post.bat - Poster (Taakplanner elke ~15 min, StartWhenAvailable, stil via stil.vbs).
REM Post wat due is (incl. gemiste posts tot 2 dagen terug). Start de engine alleen als er echt
REM iets te posten is. Alles naar out\logs\post_log.txt. GEEN hibernate (draait overdag).
cd /d "C:\Users\Nimo1\Desktop\content-engine"
if not exist "out\logs" mkdir "out\logs"
echo ===== POSTER %DATE% %TIME% =====>> "out\logs\post_log.txt"
node tools\post_dag.mjs --doen >> "out\logs\post_log.txt" 2>&1
