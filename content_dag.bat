@echo off
REM content_dag.bat - Nacht-render (Taakplanner 02:00, stil via stil.vbs). Rendert de dagset en
REM hibernate daarna. Alles wat node print gaat naar out\logs\render_log.txt (open dat bestand om
REM te zien wat er die nacht gebeurde). Mislukte nacht (laptop uit/update) -> content_inhaal.bat 08:00.
cd /d "C:\Users\Nimo1\Desktop\content-engine"
if not exist "out\logs" mkdir "out\logs"
echo ===== NACHT-RENDER %DATE% %TIME% =====>> "out\logs\render_log.txt"
node tools\render_dag.mjs --doen --hiberna >> "out\logs\render_log.txt" 2>&1
