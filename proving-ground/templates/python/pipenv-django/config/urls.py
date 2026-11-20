from django.http import JsonResponse
from django.urls import path


def health(request):
    return JsonResponse({"ok": True})


urlpatterns = [path("health/", health)]
