from fastapi.testclient import TestClient

from app import app

client = TestClient(app)


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_echo():
    response = client.post("/echo", json={"message": "hi", "count": 2})
    assert response.status_code == 200
    assert response.json() == {"echoed": ["hi", "hi"]}
