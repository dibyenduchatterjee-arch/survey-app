from fastapi import FastAPI

from app.api import auth, forms

app = FastAPI(title="Evidence Action survey platform")
app.include_router(auth.router)
app.include_router(forms.router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
