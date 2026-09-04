import json
import os
import shutil
from services.lib.LAV_logger import logger

from .BaseLLM import BaseLLM
from .OllamaCloudLLM import OllamaCloudLLM


class LLM:
    def __init__(self, gpu_layers=-1):
        self.current_module_directory = os.path.dirname(__file__)
        self.models_directory = os.path.join(self.current_module_directory, "Models")
        self.current_model_data = None
        self.llm: BaseLLM | None = None
        self.all_model_data = None
        self.keep_model_loaded = False

        self.provider = "ollama_cloud"
        self.ollama_model = "gpt-oss:120b"
        self.ollama_base_url = "https://ollama.com"
        self.ollama_llm: OllamaCloudLLM | None = None
        self.spotify_mcp_enabled = False
        self.browser_mcp_enabled = False
        
        # Default sampling parameters
        self.sampling_params = {
            'top_k': 40,
            'top_p': 0.95,
            'min_p': 0.05,
            'repeat_penalty': 1.1,
            'temperature': 0.8,
            'seed': -1
        }

        # Initialize models directory if it doesn't exist
        if not os.path.exists(self.models_directory):
            os.makedirs(self.models_directory)

        # Load available models
        self._load_available_models()
        
        if self.provider == "gguf" and self.keep_model_loaded and self.current_model_data:
            self.load_model(self.current_model_data, gpu_layers)

    def _load_available_models(self):
        """Load all available models from metadata.json files, regardless of folder names"""
        self.all_model_data = []
        
        # Walk through all directories and subdirectories to find metadata files
        for root, dirs, files in os.walk(self.models_directory):
            # Look for metadata files with various naming conventions
            metadata_files = ['metadata.json']
            
            for metadata_file in metadata_files:
                if metadata_file in files:
                    metadata_path = os.path.join(root, metadata_file)
                    try:
                        with open(metadata_path, 'r', encoding='utf-8') as f:
                            model_data = json.load(f)
                        
                        # Add additional information
                        model_data['metadata_path'] = metadata_path
                        model_data['model_folder'] = root
                        
                        # Check if model file exists and get its size
                        model_file_path = os.path.join(root, model_data.get('fileName', ''))
                        model_data['file_exists'] = os.path.exists(model_file_path)
                        
                        if model_data['file_exists']:
                            try:
                                file_size = os.path.getsize(model_file_path)
                                model_data['file_size_bytes'] = file_size
                                model_data['file_size_readable'] = self._format_file_size(file_size)
                            except OSError:
                                model_data['file_size_bytes'] = 0
                                model_data['file_size_readable'] = "Unknown"
                        else:
                            model_data['file_size_bytes'] = 0
                            model_data['file_size_readable'] = "Not Downloaded"
                        
                        # Add vision model support check
                        if model_data.get('type') == 'vision':
                            mmproj_path = model_data.get('mmproj_path', '')
                            if mmproj_path:
                                full_mmproj_path = os.path.join(root, mmproj_path)
                                model_data['mmproj_exists'] = os.path.exists(full_mmproj_path)
                            else:
                                model_data['mmproj_exists'] = False
                        
                        self.all_model_data.append(model_data)
                        logger.debug(f"Loaded model metadata: {model_data.get('displayName', 'Unknown')} from {metadata_path}")
                        
                    except (json.JSONDecodeError, IOError) as e:
                        logger.warning(f"Could not load metadata from {metadata_path}: {e}")
                    break  # Only process the first metadata file found in each directory
        
        # Set current model if not set
        if not self.current_model_data and self.all_model_data:
            # Prefer a model that actually exists
            existing_models = [m for m in self.all_model_data if m.get('file_exists', False)]
            if existing_models:
                self.current_model_data = existing_models[0]
            else:
                self.current_model_data = self.all_model_data[0]
        
        logger.info(f"Loaded {len(self.all_model_data)} models from metadata files")

    def _format_file_size(self, size_bytes):
        """Format file size in human readable format"""
        if size_bytes == 0:
            return "0 B"
        
        size_names = ["B", "KB", "MB", "GB", "TB"]
        import math
        i = int(math.floor(math.log(size_bytes, 1024)))
        p = math.pow(1024, i)
        s = round(size_bytes / p, 2)
        return f"{s} {size_names[i]}"

    def get_model_download_info(self, model_data):
        """Get download information for a specific model"""
        return {
            'displayName': model_data.get('displayName', 'Unknown'),
            'fileName': model_data.get('fileName', ''),
            'link': model_data.get('link', ''),
            'type': model_data.get('type', 'text'),
            'file_exists': model_data.get('file_exists', False),
            'file_size_readable': model_data.get('file_size_readable', 'Unknown'),
            'model_folder': model_data.get('model_folder', '')
        }

    def _migrate_old_structure(self):
        """Migrate from old structure to new folder-based structure"""
        old_model_data_path = os.path.join(self.current_module_directory, "model_data.json")
        if not os.path.exists(old_model_data_path):
            return

        with open(old_model_data_path, 'r') as f:
            old_model_data = json.load(f)

        for model_data in old_model_data:
            model_name = model_data["fileName"]
            model_folder = os.path.join(self.models_directory, os.path.splitext(model_name)[0])
            
            # Create model folder if it doesn't exist
            if not os.path.exists(model_folder):
                os.makedirs(model_folder)

            # Move model file to its folder
            old_model_path = os.path.join(self.models_directory, model_name)
            new_model_path = os.path.join(model_folder, model_name)
            if os.path.exists(old_model_path) and not os.path.exists(new_model_path):
                shutil.move(old_model_path, new_model_path)

            # Create metadata.json in model folder
            metadata_path = os.path.join(model_folder, "metadata.json")
            if not os.path.exists(metadata_path):
                with open(metadata_path, 'w') as f:
                    json.dump(model_data, f, indent=4)

        # Remove old model_data.json
        os.remove(old_model_data_path)

    def set_provider(self, provider: str):
        if provider not in ("gguf", "ollama_cloud"):
            logger.warning(f"Unknown provider '{provider}', defaulting to 'ollama_cloud'")
            provider = "ollama_cloud"
        if self.provider == provider:
            return
        self.provider = provider
        if provider == "ollama_cloud":
            self.unload_model()
            self._ensure_ollama_client()
            logger.info(f"LLM provider set to ollama_cloud (model: {self.ollama_model})")
        else:
            self.ollama_llm = None
            logger.info("LLM provider set to gguf")

    def set_ollama_model(self, model: str):
        self.ollama_model = model
        if self.provider == "ollama_cloud":
            self._ensure_ollama_client()

    def _ensure_ollama_client(self):
        self.ollama_llm = OllamaCloudLLM(
            model=self.ollama_model,
            base_url=self.ollama_base_url,
        )

    def get_ollama_cloud_models(self) -> list:
        models_path = os.path.join(self.current_module_directory, "ollama_cloud_models.json")
        try:
            with open(models_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            logger.warning(f"Could not load Ollama cloud models: {e}")
            return []

    def validate_ollama_api_key(self) -> dict:
        api_key = os.environ.get("OLLAMA_API_KEY", "").strip()
        if not api_key:
            return {
                "api_key_set": False,
                "connected": False,
                "error": "OLLAMA_API_KEY environment variable is not set",
            }
        try:
            import httpx
            response = httpx.get(
                f"{self.ollama_base_url}/api/tags",
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=10.0,
            )
            if response.status_code == 401:
                return {
                    "api_key_set": True,
                    "connected": False,
                    "error": "Invalid or missing Ollama API key",
                }
            response.raise_for_status()
            return {
                "api_key_set": True,
                "connected": True,
                "error": None,
            }
        except Exception as e:
            return {
                "api_key_set": True,
                "connected": False,
                "error": f"Failed to connect to Ollama Cloud: {e}",
            }

    def _get_sampling_kwargs(self) -> dict:
        return {
            "top_k": self.sampling_params["top_k"],
            "top_p": self.sampling_params["top_p"],
            "min_p": self.sampling_params["min_p"],
            "repeat_penalty": self.sampling_params["repeat_penalty"],
            "temperature": self.sampling_params["temperature"],
            "seed": self.sampling_params["seed"],
        }

    def load_model_by_filename(self, model_filename: str, gpu_layers=-1):
        """Load a model by its filename"""
        if self.provider == "ollama_cloud":
            return True
        self._load_available_models()
        for model_data in self.all_model_data:
            if model_data.get("fileName") == model_filename:
                self.load_model(model_data, gpu_layers)
                return True
        logger.error(f"Model {model_filename} not found.")
        return False
        
    def load_model(self, model_data: dict, gpu_layers=-1):
        """Load a model using its metadata"""
        if self.provider == "ollama_cloud":
            return
        from .TextLLM import TextLLM
        from .VisionLLM import VisionLLM
        logger.debug(f"Loading model {model_data}...")
        if (self.llm and self.current_model_data.get('fileName') == model_data.get('fileName')):
            logger.debug(f"Same model already loaded, load cancelled...")
            return

        self.current_model_data = model_data
        model_name = model_data.get("fileName")
        
        # Use the model_folder from metadata if available, otherwise fall back to old method
        if 'model_folder' in model_data:
            model_folder = model_data['model_folder']
        else:
            model_folder = os.path.join(self.models_directory, os.path.splitext(model_name)[0])
        
        model_path = os.path.join(model_folder, model_name)

        if not os.path.exists(model_path):
            logger.error(f"Model {model_name} not found at {model_path}. Please download the model first.")
            return
        else:
            self.unload_model()
            if model_data.get("type") == "text":
                self.llm = TextLLM(model_path=model_path, n_ctx=4096, n_gpu_layers=gpu_layers, seed=-1)
            elif model_data.get("type") == "vision":
                mmproj_path = model_data.get("mmproj_path")
                if mmproj_path:
                    full_mmproj_path = os.path.join(model_folder, mmproj_path)
                    if os.path.exists(full_mmproj_path):
                        self.llm = VisionLLM(model_path=model_path, mmproj_path=full_mmproj_path, n_ctx=4096, n_gpu_layers=gpu_layers, seed=-1)
                    else:
                        logger.error(f"Vision model mmproj file not found: {full_mmproj_path}")
                        return
                else:
                    logger.error(f"Vision model missing mmproj_path in metadata")
                    return

            logger.info(f"Model changed to {model_name}.")

    def unload_model(self):
        if self.provider == "ollama_cloud":
            return
        if self.llm:
            del self.llm
            self.llm = None
            logger.info("Model unloaded.")

    def set_keep_model_loaded(self, value):
        if self.provider == "ollama_cloud":
            self.keep_model_loaded = value
            return
        self.keep_model_loaded = value
        if value == True:
            self.load_model(self.current_model_data)
        else:
            self.unload_model()

    def update_sampling_params(self, params: dict):
        """Update sampling parameters - no model reload needed as these are inference-time parameters"""
        self.sampling_params.update(params)
        logger.info(f"Updated sampling parameters: {self.sampling_params}")

    def set_spotify_mcp_enabled(self, enabled: bool):
        from services.MCP import mcp_registry

        self.spotify_mcp_enabled = bool(enabled)
        mcp_registry.set_spotify_enabled(self.spotify_mcp_enabled)

    def set_browser_mcp_enabled(self, enabled: bool):
        from services.MCP import mcp_registry

        self.browser_mcp_enabled = bool(enabled)
        mcp_registry.set_browser_enabled(self.browser_mcp_enabled)

    def configure_browser_mcp(self, port: int, agent_id: str):
        from services.MCP import browser_mcp

        browser_mcp.configure(port=port, agent_id=agent_id)

    def any_mcp_enabled(self) -> bool:
        return self.spotify_mcp_enabled or self.browser_mcp_enabled

    def get_completion(self, text, history, system_prompt, screenshot=False, images=None):
        if self.provider == "ollama_cloud":
            if not self.ollama_llm:
                self._ensure_ollama_client()
            if self.any_mcp_enabled():
                from services.MCP import MCPToolAgent, mcp_registry

                agent = MCPToolAgent(self.ollama_llm, mcp_registry)
                return agent.run(
                    text,
                    history,
                    system_prompt,
                    images=images,
                    **self._get_sampling_kwargs(),
                )
            return self.ollama_llm.get_chat_completion(
                text,
                history,
                system_prompt,
                images=images,
                **self._get_sampling_kwargs(),
            )

        if not self.llm:
            self.load_model(self.current_model_data)

        from .TextLLM import TextLLM
        from .VisionLLM import VisionLLM

        response = None
        if isinstance(self.llm, VisionLLM):
            response = self.llm.get_chat_completion(text, history, system_prompt, screenshot)
        elif isinstance(self.llm, TextLLM):
            response = self.llm.get_chat_completion(
                text, 
                history, 
                system_prompt,
                **self._get_sampling_kwargs(),
            )
        if not self.keep_model_loaded:
            self.unload_model()
        return response

    def complete_current_response(self, history, system_prompt):
        """Complete the current response with sampling parameters from settings"""
        if self.provider == "ollama_cloud":
            if not self.ollama_llm:
                self._ensure_ollama_client()
            return self.ollama_llm.complete_current_response(
                history,
                system_prompt,
                **self._get_sampling_kwargs(),
            )

        if not self.llm:
            self.load_model(self.current_model_data)

        from .TextLLM import TextLLM

        response = None
        if isinstance(self.llm, TextLLM):
            response = self.llm.complete_current_response(
                history, 
                system_prompt,
                **self._get_sampling_kwargs(),
            )
        
        if not self.keep_model_loaded:
            self.unload_model()
        return response
