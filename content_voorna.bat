@echo off
REM content_voorna.bat - ochtendstap: voor&na-video + carrousel (NL/EN/FR) van het verse paar.
REM Aangeroepen door de showcase-keten NADAT het paar is gemaakt. Rendert alleen bij een vers paar
REM van vandaag (guard zit in render_dag). Posten gebeurt pas op de knop na goedkeuring.
cd /d "C:\Users\Nimo1\Desktop\content-engine"
if not exist "out\logs" mkdir "out\logs"
echo ===== VOORNA OCHTEND %DATE% %TIME% =====>> "out\logs\voorna_ochtend.txt"
node tools\render_dag.mjs --doen --types voorna --carrousel --geenmarker >> "out\logs\voorna_ochtend.txt" 2>&1
