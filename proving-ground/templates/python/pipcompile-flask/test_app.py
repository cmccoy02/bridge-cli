from app import create_app


def test_health():
    client = create_app().test_client()
    response = client.get("/health")
    assert response.status_code == 200
    assert response.get_json() == {"ok": True}


def test_echo_requires_message():
    client = create_app().test_client()
    response = client.post("/echo", json={})
    assert response.status_code == 400
