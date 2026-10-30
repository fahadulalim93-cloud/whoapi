#!/usr/bin/env python3
import logging
import os
import sys
from flask import Flask
from anipm_proxy import anipm_bp

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stdout,
)

app = Flask(__name__)
app.register_blueprint(anipm_bp)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8095)), debug=False, threaded=True)
