from flask import Flask, jsonify, request


def create_app() -> Flask:
    app = Flask(__name__)

    @app.get("/health")
    def health():
        return jsonify(ok=True)

    @app.post("/echo")
    def echo():
        data = request.get_json(silent=True) or {}
        message = data.get("message")
        if not message:
            return jsonify(error="message required"), 400
        return jsonify(echoed=message)

    return app


app = create_app()
