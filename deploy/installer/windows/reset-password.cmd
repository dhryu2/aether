@echo off
rem Reset the Aether password. The program folder is the parent of this bin folder.
"%~dp0..\node\AetherNode.exe" "%~dp0..\server\index.mjs" --reset-password
pause
