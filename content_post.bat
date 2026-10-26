@echo off
REM content_post.bat
REM Poster: post wat er in het goedgekeurde plan due is. Draait elke ~15 min via Taakplanner
REM (+ StartWhenAvailable), dus gemiste posts gaan er alsnog uit zodra de laptop aan is.
REM Start de engine alleen als er echt iets te posten is. GEEN hibernate (draait overdag).

cd /d "C:\Users\Nimo1\Desktop\content-engine"
if not exist "out\logs" mkdir "out\logs"

echo ===== %DATE% %TIME% ===== >> "out\logs\post_log.txt"
node tools\post_dag.mjs --doen >> "out\logs\post_log.txt" 2>&1
