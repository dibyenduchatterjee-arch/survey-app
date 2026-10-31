from fastapi import FastAPI

app = FastAPI(title="Evidence Action survey platform")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
