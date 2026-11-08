#!/bin/sh
# Build this Informer app's public/ and root index.html from the arcade's web/ (single source of truth).
# Informer serves ONLY the App's root page for every view path, so the App is one page: web/hospital/index.html
# (sign-in, then tabs: worklist with the GlioAgent assistant, clinician tool, Practice · Daily Workup, steward dashboard).
# Its ../ paths are rewritten for the root, and config.js (team log on) is added.
set -e
cd "$(dirname "$0")"; W=../../../web
rm -rf public/clinic public/hospital
mkdir -p public/js public/css public/hospital
cp $W/css/style.css public/css/style.css
cp $W/clinic/clinic.css public/clinic.css
cp $W/clinic/model.json public/model.json
cp $W/js/clinic_engine.js $W/js/clinic.js $W/js/hospital.js public/js/
cp $W/favicon.svg public/favicon.svg
cp $W/hospital/hospital.css $W/hospital/cases.json public/hospital/
sed -e 's#"\.\./clinic/clinic\.css"#"clinic.css"#; s#"\.\./clinic/model\.json"#"model.json"#; s#"\.\./#"#g' \
    -e 's#href="hospital\.css"#href="hospital/hospital.css"#; s#data-cases="cases\.json"#data-cases="hospital/cases.json"#' \
    -e 's#<script src="js/clinic_engine\.js"></script>#<script src="config.js"></script>\n<script src="js/clinic_engine.js"></script>#' \
    $W/hospital/index.html > index.html
grep -q 'src="config.js"' index.html && grep -q 'data-cases="hospital/cases.json"' index.html && ! grep -q '\.\./' index.html
