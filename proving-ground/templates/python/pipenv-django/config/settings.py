from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = "pg-insecure-test-key"
DEBUG = True
ALLOWED_HOSTS = ["*"]

INSTALLED_APPS = ["core"]
MIDDLEWARE = []
ROOT_URLCONF = "config.urls"
TEMPLATES = []

DATABASES = {
    "default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}
}

USE_TZ = True
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
