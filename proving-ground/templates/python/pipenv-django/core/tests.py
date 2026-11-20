from django.test import Client, SimpleTestCase


class HealthTests(SimpleTestCase):
    def test_health(self):
        response = Client().get("/health/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True})
