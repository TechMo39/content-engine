' stil.vbs
' Draait een bat-bestand onzichtbaar, zonder dat er een zwart venster opent.
'
' WAAROM DIT ER IS
' De raadronde en de zoekronde draaien elk (half) uur via Taakplanner. Zonder dit hulpje
' popt er elke keer een cmd-venster op dat na een paar minuten weer sluit. Hinderlijk als
' je aan het werk bent. Dit hulpje start dezelfde bat, maar onzichtbaar: het werk gebeurt
' op de achtergrond, het logbestand wordt gewoon geschreven.
'
' Taakplanner roept aan: wscript stil.vbs "C:\...\raadronde.bat"
' Het pad naar de bat komt als eerste argument binnen.

Set args = WScript.Arguments
If args.Count = 0 Then WScript.Quit
Set shell = CreateObject("WScript.Shell")
' De 0 is het venster: onzichtbaar. De True: wacht tot de bat klaar is, zodat Taakplanner
' ziet wanneer het werk gedaan is.
shell.Run """" & args(0) & """", 0, True
