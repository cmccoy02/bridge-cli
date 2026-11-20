from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()


class Echo(BaseModel):
    message: str
    count: int = 1


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/echo")
def echo(body: Echo) -> dict:
    return {"echoed": [body.message] * body.count}
