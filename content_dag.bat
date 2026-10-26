@echo off
REM content_dag.bat
REM Nacht-taak: rendert de dagelijkse set video's en hibernate daarna. Voor Windows Taakplanner,
REM dagelijks 02:00, met "Wake the computer to run this task" aan. Stil gestart via stil.vbs.
REM Staat de laptop uit en wekt hij niet, dan pakt content_inhaal.bat (08:00) het alsnog op.

cd /d "C:\Users\Nimo1\Desktop\content-engine"
if not exist "out\logs" mkdir "out\logs"

echo. >> "out\logs\render_dag_log.txt"
echo ===== %DATE% %TIME% (nacht) ===== >> "out\logs\render_dag_log.txt"
node tools\render_dag.mjs --doen --hiberna >> "out\logs\render_dag_log.txt" 2>&1
