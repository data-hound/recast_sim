#!/bin/sh
# Copy the clinician tool, the hospital simulation and Daily Workup from the arcade's web/ (single source of truth)
# into this Informer app's public/, keeping web/'s relative layout (js/, css/, clinic/, hospital/).
set -e
cd "$(dirname "$0")"; W=../../../web
mkdir -p public/js public/css public/clinic public/hospital
cp $W/css/style.css public/css/style.css
cp $W/clinic/clinic.css public/clinic.css
cp $W/clinic/model.json public/model.json
cp $W/clinic/model.json public/clinic/model.json
cp $W/js/clinic_engine.js $W/js/clinic.js public/js/
cp $W/favicon.svg public/favicon.svg
if [ -f $W/hospital/index.html ] && [ -f $W/js/hospital.js ] && [ -z "$SKIP_HOSPITAL" ]; then
  cp $W/hospital/index.html $W/hospital/hospital.css $W/hospital/cases.json public/hospital/
  cp $W/js/hospital.js public/js/
fi
