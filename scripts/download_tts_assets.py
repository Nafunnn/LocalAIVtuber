"""Download GPT-SoVITS pretrained models required for TTS."""
import os
from huggingface_hub import hf_hub_download, snapshot_download

BASE = os.path.join(
    os.path.dirname(__file__),
    "..",
    "backend",
    "services",
    "TTS",
    "GPTsovits",
    "GPT_SoVITS",
    "pretrained_models",
)
BASE = os.path.abspath(BASE)
os.makedirs(BASE, exist_ok=True)

print(f"Target directory: {BASE}")

# GPT-SoVITS v2 weights from official repo
GSV_FILES = [
    "gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt",
    "gsv-v2final-pretrained/s2G2333k.pth",
]

for file in GSV_FILES:
    print(f"Downloading {file}...")
    path = hf_hub_download(
        repo_id="lj1995/GPT-SoVITS",
        filename=file,
        local_dir=BASE,
    )
    print(f"  -> {path}")

# Chinese BERT and HuBERT models
print("Downloading chinese-roberta-wwm-ext-large...")
snapshot_download(
    repo_id="hfl/chinese-roberta-wwm-ext-large",
    local_dir=os.path.join(BASE, "chinese-roberta-wwm-ext-large"),
)

print("Downloading chinese-hubert-base...")
hubert_dir = os.path.join(BASE, "chinese-hubert-base")
os.makedirs(hubert_dir, exist_ok=True)
snapshot_download(
    repo_id="TencentGameMate/chinese-hubert-base",
    local_dir=hubert_dir,
    local_dir_use_symlinks=False,
)

print("Done.")
